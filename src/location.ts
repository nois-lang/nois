import { isNewline } from './lexer/lexer'
import { Source } from './source'
import { range } from './util/array'

export interface LocationRange {
    start: number
    end: number
}

export interface Location {
    line: number,
    column: number
}

export const indexToLocation = (index: number, source: Source): Location | undefined => {
    let line = 0
    let column = 0
    for (let i = 0; i <= index; i++) {
        if (i === index) {
            return { line, column }
        }
        if (isNewline(source.str[i])) {
            line++
            column = 0
        } else {
            column++
        }
    }
    return undefined
}

export const prettyLineAt = (start: Location, source: Source, context: number = 0): string => {
    if (!start) return '<outside of a file>'
    const highlight = ' '.repeat(6 + start.column) + '^'
    const linesBefore = range(0, Math.min(context, start.line)).map(i => start.line + i - context).map(i => prettyLine(i, source))
    const totalLines = source.str.split('\n').filter(l => l.length === 0).length
    const linesAfterCount = Math.min(context, Math.max(0, totalLines - 1 - start.line))
    const linesAfter = range(0, linesAfterCount).map(i => start.line + i + context).map(i => prettyLine(i, source))

    return [linesBefore.join('\n'), prettyLine(start.line, source), highlight, linesAfter.join('\n')].join('\n')
}

export const prettyLine = (lineIndex: number, source: Source): string => {
    const lines = source.str.split('\n')
    const line = lines[lineIndex]
    const lineNum = `${(lineIndex + 1).toString()} | `.padStart(6)
    return lineNum + line
}

export const locationToString = (location: Location): string => `${location.line + 1}:${location.column + 1}`
