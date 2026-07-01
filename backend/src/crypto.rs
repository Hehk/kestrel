use aes_gcm::{
    aead::{rand_core::RngCore, Aead, OsRng},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

use crate::config::TokenEncryptionKey;

const TOKEN_CIPHERTEXT_VERSION: &str = "v1";

#[derive(Clone)]
pub struct TokenCipher {
    cipher: Aes256Gcm,
}

impl TokenCipher {
    pub fn new(key: &TokenEncryptionKey) -> Self {
        let cipher = Aes256Gcm::new_from_slice(key.as_bytes())
            .expect("token encryption key length is validated by config");
        Self { cipher }
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String, CryptoError> {
        let mut nonce_bytes = [0_u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);

        let ciphertext = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
            .map_err(|_| CryptoError::Encrypt)?;

        Ok(format!(
            "{TOKEN_CIPHERTEXT_VERSION}:{}:{}",
            URL_SAFE_NO_PAD.encode(nonce_bytes),
            URL_SAFE_NO_PAD.encode(ciphertext)
        ))
    }

    pub fn decrypt(&self, encrypted: &str) -> Result<String, CryptoError> {
        let (version, rest) = encrypted
            .split_once(':')
            .ok_or(CryptoError::InvalidFormat)?;
        if version != TOKEN_CIPHERTEXT_VERSION {
            return Err(CryptoError::UnsupportedVersion);
        }

        let (nonce, ciphertext) = rest.split_once(':').ok_or(CryptoError::InvalidFormat)?;
        if ciphertext.contains(':') {
            return Err(CryptoError::InvalidFormat);
        }

        let nonce = URL_SAFE_NO_PAD
            .decode(nonce)
            .map_err(|_| CryptoError::InvalidFormat)?;
        let nonce: [u8; 12] = nonce.try_into().map_err(|_| CryptoError::InvalidFormat)?;
        let ciphertext = URL_SAFE_NO_PAD
            .decode(ciphertext)
            .map_err(|_| CryptoError::InvalidFormat)?;

        let plaintext = self
            .cipher
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|_| CryptoError::Decrypt)?;

        String::from_utf8(plaintext).map_err(|_| CryptoError::InvalidUtf8)
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum CryptoError {
    Decrypt,
    Encrypt,
    InvalidFormat,
    InvalidUtf8,
    UnsupportedVersion,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Decrypt => write!(f, "token decryption failed"),
            Self::Encrypt => write!(f, "token encryption failed"),
            Self::InvalidFormat => write!(f, "encrypted token has an invalid format"),
            Self::InvalidUtf8 => write!(f, "decrypted token is not valid UTF-8"),
            Self::UnsupportedVersion => write!(f, "encrypted token version is unsupported"),
        }
    }
}

impl std::error::Error for CryptoError {}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine};

    use super::{CryptoError, TokenCipher};
    use crate::config::TokenEncryptionKey;

    fn test_cipher() -> TokenCipher {
        let key = TokenEncryptionKey::from_base64(&STANDARD.encode([7_u8; 32]))
            .expect("test key should parse");
        TokenCipher::new(&key)
    }

    #[test]
    fn encrypts_and_decrypts_token() {
        let cipher = test_cipher();

        let encrypted = cipher
            .encrypt("github_access_token")
            .expect("token should encrypt");

        assert_ne!(encrypted, "github_access_token");
        assert_eq!(
            cipher.decrypt(&encrypted).expect("token should decrypt"),
            "github_access_token"
        );
    }

    #[test]
    fn uses_a_random_nonce() {
        let cipher = test_cipher();

        let first = cipher.encrypt("same_token").expect("token should encrypt");
        let second = cipher.encrypt("same_token").expect("token should encrypt");

        assert_ne!(first, second);
    }

    #[test]
    fn rejects_tampered_token() {
        let cipher = test_cipher();
        let mut tampered = cipher.encrypt("token").expect("token should encrypt");
        let last = tampered.pop().expect("encrypted token should not be empty");
        tampered.push(if last == 'A' { 'B' } else { 'A' });

        assert_eq!(cipher.decrypt(&tampered), Err(CryptoError::Decrypt));
    }
}
