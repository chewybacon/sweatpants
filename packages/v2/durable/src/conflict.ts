/**
 * A journal observation lost a race before delivery authority was acquired.
 * Hosts may reread and reactivate; this never authorizes handler redelivery.
 * Settlement and invalid-grant failures deliberately do not use this error.
 */
export class JournalConflict extends Error {
  override readonly name = "JournalConflict";
}
