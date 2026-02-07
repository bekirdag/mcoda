import path from "node:path";

export const PRIMARY_OPENAPI_FILENAME = "mcoda.yaml";
export const ADMIN_OPENAPI_FILENAME = "mcoda-admin.yaml";

export type OpenApiVariant = "primary" | "admin";

export class GenOpenapi {
  static primaryFilename(): string {
    return PRIMARY_OPENAPI_FILENAME;
  }

  static adminFilename(): string {
    return ADMIN_OPENAPI_FILENAME;
  }

  static resolveOutputPath(root: string, variant: OpenApiVariant = "primary"): string {
    return path.join(root, variant === "admin" ? ADMIN_OPENAPI_FILENAME : PRIMARY_OPENAPI_FILENAME);
  }
}
