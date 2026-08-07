export type MailAdapterErrorCode =
  | 'EXECUTION_FAILED'
  | 'EXECUTION_TIMEOUT'
  | 'INVALID_INPUT'
  | 'MALFORMED_RESPONSE'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'UNSUPPORTED_OPERATION';

const ERROR_MESSAGES: Record<MailAdapterErrorCode, string> = {
  EXECUTION_FAILED: 'Apple Mail could not complete the read-only request.',
  EXECUTION_TIMEOUT: 'The read-only Apple Mail request timed out.',
  INVALID_INPUT: 'The Apple Mail request input is invalid.',
  MALFORMED_RESPONSE: 'Apple Mail returned an invalid response.',
  OUTPUT_LIMIT_EXCEEDED:
    'The Apple Mail response exceeded the safe size limit.',
  UNSUPPORTED_OPERATION: 'The requested Apple Mail operation is not supported.',
};

export class MailAdapterError extends Error {
  readonly code: MailAdapterErrorCode;

  constructor(code: MailAdapterErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'MailAdapterError';
    this.code = code;
  }
}

export type MailRunnerErrorCode =
  'OUTPUT_LIMIT' | 'PROCESS_FAILURE' | 'TIMEOUT';

export class MailRunnerError extends Error {
  readonly code: MailRunnerErrorCode;

  constructor(code: MailRunnerErrorCode) {
    super('The fixed Apple Mail script did not complete successfully.');
    this.name = 'MailRunnerError';
    this.code = code;
  }
}
