import { TokenKind } from './parser/parser'
import { indexToLocation, LocationRange, prettyIndex, prettyLocation } from './location'
import { Source } from './source'
import { Token } from './lexer/lexer'

export interface SyntaxErrorInfo {
    expected: TokenKind[],
    got: TokenKind,
    location: LocationRange
}

export const prettyLexerError = (token: Token): string => {
    return `lexer error: unknown token \`${token.value}\``
}

export const prettySyntaxError = (error: SyntaxErrorInfo): string => {
    return `syntax error: expected \`${error.expected}\`, got \`${error.got}\``
}

export const prettySourceMessage = (message: string, index: number, source: Source): string => {
    const location = indexToLocation(index, source)
    const locationStr = `${location ? `${source.filename}:${prettyLocation(location)}` : '<unknwon location>'}`
    const indent = ' '.repeat(4)
    return `\
${prettyIndex(index, source)}
${message}
${indent}at ${locationStr}
`
}
