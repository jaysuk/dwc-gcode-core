/** Character-class tests on char codes, shared by the lexer and the parameter parser. Not exported. */

export function isSpace(code: number): boolean {
	return code === 32 || code === 9 || code === 13;
}
export function isDigit(code: number): boolean {
	return code >= 48 && code <= 57;
}
export function isLetter(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
