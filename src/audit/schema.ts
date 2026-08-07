import type {
  AccessTransport,
  MailToolName,
  ProtocolEra,
} from '../access/types';

export const AUDIT_SCHEMA_VERSION = 1 as const;

export const AUDIT_REASON_CODES = [
  'ALLOW_POLICY',
  'DENY_TOOL',
  'DENY_FOLDER',
  'DENY_BODY',
] as const;

export type AuditReasonCode = (typeof AUDIT_REASON_CODES)[number];

export interface UntrustedMcpClient {
  name: string;
  version: string;
}

export interface AuditEntry {
  clientId: string;
  decision: 'allow' | 'deny';
  eventId: string;
  protocolEra: ProtocolEra;
  reason: AuditReasonCode;
  schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  timestamp: string;
  tool: MailToolName;
  transport: AccessTransport;
  untrustedMcpClient?: UntrustedMcpClient;
}

export type AuditEntryInput = Omit<
  AuditEntry,
  'eventId' | 'schemaVersion' | 'timestamp'
>;
