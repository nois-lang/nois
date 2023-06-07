import { tokenize } from './lexer/lexer'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'


const version = JSON.parse(readFileSync(join(__dirname, '..', 'package.json')).toString()).version

export const usage = `\
Nois transpiler - v${version}

Usage: nois file`

const path = process.argv.slice(2).at(0)
if (!path) {
    console.log(usage)
    process.exit()
}
const source = { str: readFileSync(resolve(path)).toString(), filename: path }

const tokens = tokenize(source.str)
// const token = parse(tokens)
// if ('expected' in token) {
//     console.error(prettySourceMessage(prettySyntaxError(token), token.location.start, source))
//     process.exit(1)
// }
//
// console.dir(compactToken(flattenToken(token)), { depth: null, colors: true, compact: true })
