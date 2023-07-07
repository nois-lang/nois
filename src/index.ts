import { existsSync, readFileSync } from 'fs'
import { join, relative, resolve } from 'path'
import { prettyError, prettySourceMessage, prettyWarning } from './error'
import { Module, } from './ast'
import { checkModule } from './semantic'
import { buildModule, Context, pathToVid } from './scope'
import * as console from 'console'
import { indexToLocation } from './location'
import * as process from 'process'
import { getPackageModuleSources } from './scope/io'
import { getLocationRange } from './parser'
import { defaultConfig } from './config'
import { Source } from './source'
import { glanceModule } from './semantic/glance'

const checkForErrors = (ctx: Context) => {
    if (ctx.errors.length > 0) {
        for (const error of ctx.errors) {
            console.error(prettySourceMessage(
                prettyError(error.message),
                indexToLocation(getLocationRange(error.node.parseNode).start, error.module.source)!,
                error.module.source
            ))
        }
        process.exit(1)
    }
}

const version = JSON.parse(readFileSync(join(__dirname, '..', 'package.json')).toString()).version

export const usage = `\
Nois transpiler - v${version}

Usage: nois file`

const path = process.argv.slice(2).at(0)
if (!path) {
    console.log(usage)
    process.exit()
}
const sourcePath = resolve(path)
if (!existsSync(sourcePath)) {
    console.error(`no such file \`${path}\``)
    process.exit()
}
const source: Source = { code: readFileSync(sourcePath).toString(), filepath: sourcePath }

const moduleAst = buildModule(source, pathToVid(sourcePath))

if (!moduleAst) {
    process.exit(1)
}

const stdPath = join(__dirname, 'std')
const stdModules = getPackageModuleSources(stdPath).map(s => {
    const stdModule = buildModule(s, pathToVid(relative(stdPath, s.filepath), 'std'))
    if (!stdModule) {
        process.exit(1)
    }
    return stdModule
})

const config = defaultConfig()
const ctx: Context = {
    config,
    moduleStack: [],
    modules: [...<Module[]>stdModules, moduleAst],
    errors: [],
    warnings: []
}

ctx.modules.forEach(m => { glanceModule(m, ctx) })
checkForErrors(ctx)

ctx.modules.forEach(m => { checkModule(m, ctx) })
checkForErrors(ctx)

for (const warning of ctx.warnings) {
    console.error(prettySourceMessage(
        prettyWarning(warning.message),
        indexToLocation(getLocationRange(warning.node.parseNode).start, warning.module.source)!,
        warning.module.source
    ))
}
