import { Parser } from '../parser'
import { parseArgs, parseConOp } from './index'

/**
 * infix-op ::= add-op | sub-op | mul-op | div-op | exp-op | mod-op | access-op | eq-op | ne-op | ge-op | le-op | gt-op
 * | lt-op | and-op | or-op | assign-op;
 */
export const parseInfixOp = (parser: Parser): void => {
    const mark = parser.open()
    if (parser.consume('plus')) {
        parser.close(mark, 'add-op')
        return
    }
    if (parser.consume('minus')) {
        parser.close(mark, 'sub-op')
        return
    }
    if (parser.consume('asterisk')) {
        parser.close(mark, 'mul-op')
        return
    }
    if (parser.consume('slash')) {
        parser.close(mark, 'div-op')
        return
    }
    if (parser.consume('caret')) {
        parser.close(mark, 'exp-op')
        return
    }
    if (parser.consume('percent')) {
        parser.close(mark, 'mod-op')
        return
    }
    if (parser.consume('period')) {
        parser.close(mark, 'access-op')
        return
    }
    if (parser.at('equals') && parser.nth(1) === 'equals') {
        parser.advance()
        parser.advance()
        parser.close(mark, 'eq-op')
        return
    }
    if (parser.at('excl') && parser.nth(1) === 'equals') {
        parser.advance()
        parser.advance()
        parser.close(mark, 'ne-op')
        return
    }
    if (parser.consume('c-angle')) {
        if (parser.consume('equals')) {
            parser.close(mark, 'ge-op')
        } else {
            parser.close(mark, 'gt-op')
        }
        return
    }
    if (parser.consume('o-angle')) {
        if (parser.consume('equals')) {
            parser.close(mark, 'le-op')
        } else {
            parser.close(mark, 'lt-op')
        }
        return
    }
    if (parser.consume('ampersand')) {
        parser.advance()
        parser.close(mark, 'and-op')
        return
    }
    if (parser.consume('pipe')) {
        parser.advance()
        parser.close(mark, 'or-op')
        return
    }
    if (parser.consume('equals')) {
        parser.close(mark, 'assign-op')
        return
    }

    parser.advanceWithError('expected infix operator')
}

/**
 * prefix-op ::= add-op | sub-op | not-op | spread-op
 */
export const parsePrefixOp = (parser: Parser): void => {
    const mark = parser.open()
    const m = parser.open()

    if (parser.consume('plus')) {
        parser.close(m, 'add-op')
    } else if (parser.consume('minus')) {
        parser.close(m, 'sub-op')
    } else if (parser.consume('excl')) {
        parser.close(m, 'not-op')
    } else if (parser.at('period') && parser.nth(1) === 'period') {
        parser.advance()
        parser.advance()
        parser.close(m, 'spread-op')
    } else {
        parser.advanceWithError('expected prefix operator')
        parser.close(m, 'error')
    }

    parser.close(mark, 'prefix-op')
}

export const parseSpreadOp = (parser: Parser): void => {
    const mark = parser.open()
    parser.expect('period')
    parser.expect('period')
    parser.close(mark, 'spread-op')
}

/**
 * postfix-op ::= call-op
 */
export const parsePostfixOp = (parser: Parser): void => {
    const mark = parser.open()
    if (parser.at('o-paren') && parser.nth(1) === 'identifier' && parser.nth(2) === 'colon') {
        parseConOp(parser)
    } else if (parser.at('o-paren')) {
        parseCallOp(parser)
    } else {
        parser.advanceWithError('expected postfix operator')
    }
    parser.close(mark, 'postfix-op')
}

/**
 * call-op ::= args
 */
export const parseCallOp = (parser: Parser): void => {
    const mark = parser.open()
    if (parser.at('o-paren')) {
        parseArgs(parser)
    } else {
        parser.advanceWithError('expected call operator')
    }
    parser.close(mark, 'call-op')
}
