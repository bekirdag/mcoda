import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Index } from "../index.js";
import { DocsScaffolder } from "../scaffolding/docs/DocsScaffolder.js";
import { WorkspaceScaffolder } from "../scaffolding/workspace/WorkspaceScaffolder.js";
import { GlobalScaffolder } from "../scaffolding/global/GlobalScaffolder.js";
import { GenerateTypes } from "../openapi/generateTypes.js";
import { ValidateSchema } from "../openapi/validateSchema.js";
import { ValidateSqlSchema } from "../sql/validateSchema.js";

describe("generators shells", () => {
  it("exports scaffolders and generators", () => {
    assert.ok(new Index());
    assert.ok(new DocsScaffolder());
    assert.ok(new WorkspaceScaffolder());
    assert.ok(new GlobalScaffolder());
    assert.ok(new GenerateTypes());
    assert.ok(new ValidateSchema());
    assert.ok(new ValidateSqlSchema());
  });
});

describe("DocsScaffolder deployment blueprint", () => {
  it("generates deterministic artifacts with ports and env mapping", () => {
    const scaffolder = new DocsScaffolder();
    const sds = [
      "# SDS",
      "We use MySQL for persistence.",
      "Redis is used for caching.",
    ].join("\n");
    const openapi = [
      "openapi: 3.1.0",
      "info:",
      "  title: Demo",
      "  version: 1.0.0",
      "servers:",
      "  - url: http://localhost:8080",
      "paths:",
      "  /health:",
      "    get:",
      "      operationId: getHealth",
      "      responses:",
      "        '200':",
      "          description: ok",
    ].join("\n");

    const result = scaffolder.generateDeploymentBlueprint({
      sdsContent: sds,
      openapiContent: openapi,
      outputDir: "/tmp/deploy",
      serviceName: "sample-service",
    });

    assert.equal(result.port, 8080);
    assert.ok(result.services.includes("mysql"));
    assert.ok(result.services.includes("redis"));

    const compose = result.files.find(
      (file) => path.basename(file.path) === "docker-compose.yml",
    );
    assert.ok(compose);
    assert.match(compose?.content ?? "", /\$\{SERVICE_PORT\}:\$\{SERVICE_PORT\}/);

    const envExample = result.files.find(
      (file) => path.basename(file.path) === ".env.example",
    );
    assert.ok(envExample);
    assert.match(envExample?.content ?? "", /SERVICE_PORT=8080/);
    assert.match(envExample?.content ?? "", /DATABASE_URL=/);
    assert.match(envExample?.content ?? "", /REDIS_URL=/);

    const envDoc = result.files.find(
      (file) => path.basename(file.path) === "env-secrets.md",
    );
    assert.ok(envDoc);

    const kustomization = result.files.find(
      (file) => path.basename(file.path) === "kustomization.yaml",
    );
    assert.ok(kustomization);
  });
});

describe("ValidateSchema", () => {
  it("flags empty paths and invalid operation ids", () => {
    const validator = new ValidateSchema();
    const spec = [
      "openapi: 2.0.0",
      "info:",
      "  title: Demo",
      "paths:",
      "  /health:",
      "    get:",
      "      operationId: bad id",
      "      responses:",
      "        '200':",
      "          description: ok",
    ].join("\n");

    const result = validator.validateContent(spec);
    assert.ok(result.errors.some((error) => error.includes("Invalid openapi version")));
    assert.ok(result.errors.some((error) => error.includes("Invalid operationId")));
    assert.ok(result.errors.some((error) => error.includes("Missing info.version")));
  });

  it("passes for a valid spec", () => {
    const validator = new ValidateSchema();
    const spec = [
      "openapi: 3.1.0",
      "info:",
      "  title: Demo",
      "  version: 1.0.0",
      "paths:",
      "  /health:",
      "    get:",
      "      operationId: getHealth",
      "      responses:",
      "        '200':",
      "          description: ok",
      "          content:",
      "            application/json:",
      "              schema:",
      "                $ref: '#/components/schemas/Health'",
      "components:",
      "  schemas:",
      "    Health:",
      "      type: object",
    ].join("\n");

    const result = validator.validateContent(spec);
    assert.equal(result.errors.length, 0);
  });
});

describe("ValidateSqlSchema", () => {
  it("flags prose lines and unterminated statements", () => {
    const validator = new ValidateSqlSchema();
    const schema = [
      "CREATE TABLE users (",
      "  id INTEGER PRIMARY KEY,",
      "  name TEXT",
      ")",
      "This is not SQL",
    ].join("\n");

    const result = validator.validateContent(schema);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some((error) => error.type === "prose" && error.line === 5));
    assert.ok(result.errors.some((error) => error.type === "unterminated"));
  });

  it("passes for valid SQL", () => {
    const validator = new ValidateSqlSchema();
    const schema = [
      "CREATE TABLE users (",
      "  id INTEGER PRIMARY KEY,",
      "  name TEXT NOT NULL",
      ");",
      "CREATE INDEX idx_users_name ON users(name);",
      "PRAGMA foreign_keys = ON;",
    ].join("\n");

    const result = validator.validateContent(schema);
    assert.equal(result.errors.length, 0);
  });
});
