import { QaContext, QaEnsureResult, QaRunResult } from './QaTypes.js';
import { QaProfile } from '@mcoda/shared/qa/QaProfile.js';

export interface QaAdapter {
  ensureInstalled(profile: QaProfile, ctx: QaContext): Promise<QaEnsureResult>;
  invoke(profile: QaProfile, ctx: QaContext): Promise<QaRunResult>;
}
