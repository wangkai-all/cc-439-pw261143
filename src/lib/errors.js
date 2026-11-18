export class IntakeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
    this.details = details;
  }
}

export const codes = {
  EMPTY_FILE: 'EMPTY_FILE',
  TOO_LARGE: 'TOO_LARGE',
  UNSUPPORTED_EXTENSION: 'UNSUPPORTED_EXTENSION',
  NOT_WELL_FORMED: 'NOT_WELL_FORMED',
  UNKNOWN_SUPPLIER: 'UNKNOWN_SUPPLIER',
  PDF_UNREADABLE: 'PDF_UNREADABLE',
  PARSE_FAILED: 'PARSE_FAILED',
};
