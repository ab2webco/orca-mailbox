// A parsed IMAP value: atom or string, NIL, or a parenthesized list. JSDoc cannot
// declare a recursive alias, so it lives here.
export type Token = string | null | Token[]
