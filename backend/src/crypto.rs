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
}

#[derive(Debug, Eq, PartialEq)]
pub enum CryptoError {
    Encrypt,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Encrypt => write!(f, "token encryption failed"),
        }
    }
}

impl std::error::Error for CryptoError {}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine};

    use super::TokenCipher;
    use crate::config::TokenEncryptionKey;

    fn test_cipher() -> TokenCipher {
        let key = TokenEncryptionKey::from_base64(&STANDARD.encode([7_u8; 32]))
            .expect("test key should parse");
        TokenCipher::new(&key)
    }

    #[test]
    fn encrypts_token() {
        let cipher = test_cipher();

        let encrypted = cipher
            .encrypt("github_access_token")
            .expect("token should encrypt");

        assert_ne!(encrypted, "github_access_token");
        assert!(encrypted.starts_with("v1:"));
    }

    #[test]
    fn uses_a_random_nonce() {
        let cipher = test_cipher();

        let first = cipher.encrypt("same_token").expect("token should encrypt");
        let second = cipher.encrypt("same_token").expect("token should encrypt");

        assert_ne!(first, second);
    }
}
