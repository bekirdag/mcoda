export interface DocdexDocument {
    id: string;
    docType: string;
    path?: string;
    title?: string;
    content?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}
export interface RegisterDocumentInput {
    docType: string;
    path?: string;
    title?: string;
    content: string;
    metadata?: Record<string, unknown>;
}
export declare class DocdexClient {
    private options;
    constructor(options?: {
        workspaceRoot?: string;
        storePath?: string;
    });
    private getStorePath;
    private normalizePath;
    private loadStore;
    private saveStore;
    fetchDocumentById(id: string): Promise<DocdexDocument>;
    findDocumentByPath(docPath: string, docType?: string): Promise<DocdexDocument | undefined>;
    search(filter: {
        docType?: string;
        projectKey?: string;
    }): Promise<DocdexDocument[]>;
    registerDocument(input: RegisterDocumentInput): Promise<DocdexDocument>;
    ensureRegisteredFromFile(docPath: string, docType: string, metadata?: Record<string, unknown>): Promise<DocdexDocument>;
}
//# sourceMappingURL=DocdexClient.d.ts.map