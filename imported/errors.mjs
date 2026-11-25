export class ImportedEditError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ImportedEditError';
    this.code = code;
  }
}
