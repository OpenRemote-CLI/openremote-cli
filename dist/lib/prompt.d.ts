/** Prompt for a text value. */
export declare function ask(question: string): Promise<string>;
/** Prompt for a secret (input masked with *). */
export declare function askSecret(question: string): Promise<string>;
/** Yes / No confirmation (default No). */
export declare function confirm(question: string): Promise<boolean>;
