export type QaTestCategory = 'unit' | 'component' | 'integration' | 'api';
export type QaToolCategory = QaTestCategory | 'e2e' | 'mocking' | 'load' | 'contract';
export type QaTechStackId = 'node' | 'python' | 'dotnet' | 'java' | 'go' | 'php' | 'ruby' | 'flutter' | 'react-native' | 'ios' | 'android' | 'cross-stack';
export type QaToolCatalog = Partial<Record<QaToolCategory, string[]>>;
export type QaToolPreferences = Partial<Record<QaToolCategory, string>>;
export interface QaTechStack {
    id: QaTechStackId;
    label: string;
    tools: QaToolCatalog;
    preferred?: QaToolPreferences;
}
export declare const QA_TEST_CATEGORY_ORDER: QaTestCategory[];
export declare const QA_TECH_STACKS: Record<QaTechStackId, QaTechStack>;
//# sourceMappingURL=QaTechStack.d.ts.map