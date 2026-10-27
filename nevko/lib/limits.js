// Field limits shared by the tool service, the import and the browser demo (pure module).

/** Maximum lengths of the tool fields (SPEC §2). */
export const FIELD_LIMITS = Object.freeze({ code: 80, location: 200, description: 1000 });

/** Maximum length of an operator name. */
export const NAME_MAX_LENGTH = 60;
