import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// This script mainly exists because the openapi-typescript CLI's --check option
// doens't work with our formatter. So we have to do the checking manually

const command = process.argv[2];
const schemaPath = resolve("src/api/schema.ts");
const openApiTempDir =
  process.env["OPENAPI_URL"] === undefined ? mkdtempSync(join(tmpdir(), "kestrel-openapi-")) : null;
if (openApiTempDir !== null) {
  process.once("exit", () => rmSync(openApiTempDir, { force: true, recursive: true }));
}
const openApiUrl = process.env["OPENAPI_URL"] ?? join(openApiTempDir, "openapi.json");
if (openApiTempDir !== null) {
  const document = execFileSync(
    "cargo",
    ["run", "--quiet", "--locked", "--manifest-path", "backend/Cargo.toml", "--", "--openapi"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  writeFileSync(openApiUrl, document);
}

const generateSchema = (outputPath) => {
  mkdirSync(dirname(outputPath), { recursive: true });
  execFileSync("openapi-typescript", [openApiUrl, "--output", outputPath], { stdio: "inherit" });
  execFileSync("oxfmt", ["--write", outputPath], { stdio: "inherit" });
};

if (command === "generate") {
  generateSchema(schemaPath);
} else if (command === "check") {
  const tempDir = mkdtempSync(join(tmpdir(), "kestrel-api-schema-"));
  const tempSchemaPath = join(tempDir, "schema.ts");

  try {
    generateSchema(tempSchemaPath);

    const expected = readFileSync(tempSchemaPath, "utf8");
    const actual = readFileSync(schemaPath, "utf8");

    if (actual !== expected) {
      console.error("Generated API schema is not up to date. Run `npm run api:generate`.");
      process.exitCode = 1;
    }
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
} else {
  console.error("Usage: node scripts/api-schema.mjs <generate|check>");
  process.exitCode = 1;
}

if (openApiTempDir !== null) rmSync(openApiTempDir, { force: true, recursive: true });
