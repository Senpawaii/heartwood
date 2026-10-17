/** A business rule was violated (maps to HTTP 409 in the daemon). */
export class DomainError extends Error {}

/** A referenced entity does not exist (maps to HTTP 404). */
export class NotFoundError extends DomainError {}
