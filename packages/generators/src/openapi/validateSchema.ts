import YAML from "yaml";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head", "trace"];
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const operationUsesJsonSchema = (operation: Record<string, any>): boolean => {
  const contentBlocks: Array<Record<string, any>> = [];
  const requestContent = operation.requestBody?.content;
  if (isPlainObject(requestContent)) contentBlocks.push(requestContent as Record<string, any>);
  const responses = operation.responses;
  if (isPlainObject(responses)) {
    for (const response of Object.values(responses)) {
      const responseContent = (response as any)?.content;
      if (isPlainObject(responseContent)) contentBlocks.push(responseContent as Record<string, any>);
    }
  }
  for (const content of contentBlocks) {
    for (const [contentType, media] of Object.entries(content)) {
      if (!contentType.toLowerCase().includes("json")) continue;
      if ((media as any)?.schema) return true;
    }
  }
  return false;
};

export class ValidateSchema {
  validateContent(raw: string): { doc?: any; errors: string[] } {
    if (!raw || !raw.trim()) {
      return { errors: ["OpenAPI spec is empty."] };
    }
    let parsed: any;
    try {
      parsed = YAML.parse(raw);
    } catch (error) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return {
          errors: [
            `OpenAPI parse failed: ${(error as Error).message ?? String(error)}`,
          ],
        };
      }
    }
    return { doc: parsed, errors: this.validateDocument(parsed) };
  }

  validateDocument(doc: any): string[] {
    const errors: string[] = [];
    if (!isPlainObject(doc)) {
      errors.push("OpenAPI spec is not an object.");
      return errors;
    }

    const version = doc.openapi;
    if (!version) {
      errors.push("Missing openapi version.");
    } else if (typeof version !== "string" || !version.startsWith("3.")) {
      errors.push(`Invalid openapi version: ${String(version)}.`);
    }

    const info = doc.info;
    if (!isPlainObject(info)) {
      errors.push("Missing info section.");
    } else {
      if (!info.title) errors.push("Missing info.title.");
      if (!info.version) errors.push("Missing info.version.");
    }

    const paths = doc.paths;
    if (!isPlainObject(paths)) {
      errors.push("Missing paths section.");
    } else if (Object.keys(paths).length === 0) {
      errors.push("paths section is empty.");
    }

    const operationIds = new Map<string, string>();
    let hasOperations = false;
    let hasJsonSchemaUsage = false;
    if (isPlainObject(paths)) {
      for (const [pathKey, pathItem] of Object.entries(paths)) {
        if (!isPlainObject(pathItem)) {
          errors.push(`Path item for ${pathKey} must be an object.`);
          continue;
        }
        const methods = HTTP_METHODS.filter((method) => method in pathItem);
        if (methods.length === 0) {
          errors.push(`Path ${pathKey} has no operations.`);
          continue;
        }
        for (const method of methods) {
          const operation = (pathItem as any)[method];
          if (!isPlainObject(operation)) {
            errors.push(`Operation ${method.toUpperCase()} ${pathKey} must be an object.`);
            continue;
          }
          hasOperations = true;
          if (operationUsesJsonSchema(operation)) {
            hasJsonSchemaUsage = true;
          }
          const operationId = operation.operationId;
          if (!operationId || typeof operationId !== "string") {
            errors.push(`Missing operationId for ${method.toUpperCase()} ${pathKey}.`);
          } else if (/\s/.test(operationId) || !OPERATION_ID_PATTERN.test(operationId)) {
            errors.push(`Invalid operationId "${operationId}" for ${method.toUpperCase()} ${pathKey}.`);
          } else if (operationIds.has(operationId)) {
            errors.push(`Duplicate operationId "${operationId}" detected.`);
          } else {
            operationIds.set(operationId, `${method.toUpperCase()} ${pathKey}`);
          }
        }
      }
    }

    const components = (doc as any).components;
    const schemas = isPlainObject(components) ? (components as any).schemas : undefined;
    const schemaCount = isPlainObject(schemas) ? Object.keys(schemas).length : 0;
    const hasSchemaRefs =
      typeof doc === "object" && JSON.stringify(doc).includes("#/components/schemas/");
    if ((hasJsonSchemaUsage || hasSchemaRefs || hasOperations) && schemaCount === 0) {
      errors.push("Missing components.schemas for JSON payloads.");
    }

    return errors;
  }
}
