import { Identifier } from '../ast/operand'
import { Module } from '../ast'
import { Context } from './index'
import { FnDef, KindDef, Statement, VarDef } from '../ast/statement'
import { todo } from '../util/todo'
import { Pattern } from '../ast/match'
import { TypeDef } from '../ast/type-def'
import { Generic } from '../ast/type'
import { checkModule } from '../semantic'

export interface VirtualIdentifier {
    scope: string[]
    name: string
}

export type Definition = Module | VarDef | FnDef | KindDef | TypeDef | Generic | { kind: 'self' }

export interface VirtualIdentifierMatch {
    qualifiedVid: VirtualIdentifier
    def: Definition
}

export function vidFromString(str: string): VirtualIdentifier {
    const tokens = str.split('::')
    return { scope: tokens.slice(0, -1), name: tokens.at(-1)! }
}

export const vidToString = (vid: VirtualIdentifier): string => [...vid.scope, vid.name].join('::')

export const vidScopeToString = (vid: VirtualIdentifier) => vid.scope.join('::')

export const vidFromScope = (vid: VirtualIdentifier): VirtualIdentifier => ({
    scope: vid.scope.slice(0, -1),
    name: vid.scope.at(-1)!
})

export const vidFirst = (vid: VirtualIdentifier): string => vid.scope.at(0) || vid.name

export const idToVid = (id: Identifier): VirtualIdentifier => ({
    scope: id.scope.map(s => s.value),
    name: id.name.value
})

export const statementVid = (statement: Statement): VirtualIdentifier | undefined => {
    switch (statement.kind) {
        case 'var-def':
            return patternVid(statement.pattern)
        case 'fn-def':
        case 'kind-def':
        case 'type-def':
            return vidFromString(statement.name.value)
    }
    return undefined
}

export const statementToDefinition = (statement: Statement): Definition | undefined => {
    switch (statement.kind) {
        case 'var-def':
        case 'fn-def':
        case 'kind-def':
        case 'type-def':
            return statement
    }
    return undefined
}

export const patternVid = (pattern: Pattern): VirtualIdentifier | undefined => {
    switch (pattern.kind) {
        case 'name':
            return vidFromString(pattern.value)
        case 'con-pattern':
            return todo('con-pattern vid')
    }
    return undefined
}

/**
 * TODO: resolve generic refs
 */
export const resolveVid = (vid: VirtualIdentifier, ctx: Context): VirtualIdentifierMatch | undefined => {
    const module = ctx.moduleStack.at(-1)!
    for (let i = module.scopeStack.length - 1; i >= 0; i--) {
        let scope = module.scopeStack[i]
        const found = scope.statements.get(vidToString(vid))
        if (found) {
            return { qualifiedVid: vid, def: found }
        }

        const matchedGeneric = scope.generics.get(vid.name)
        if (matchedGeneric) {
            return { qualifiedVid: vid, def: matchedGeneric }
        }
    }
    for (let useExpr of module.flatUseExprs!) {
        if (useExpr.name === vidFirst(vid)) {
            const merged: VirtualIdentifier = {
                scope: [...useExpr.scope, ...vid.scope],
                name: vid.name
            }
            return resolveVidMatched(merged, ctx)
        }
    }
    return undefined
}

export const resolveVidMatched = (vid: VirtualIdentifier, ctx: Context): VirtualIdentifierMatch | undefined => {
    let foundModule = ctx.modules.find(m => vidToString(m.identifier) === vidToString(vid))
    if (foundModule) {
        checkModule(foundModule, ctx)
        return { qualifiedVid: vid, def: foundModule }
    }
    foundModule = ctx.modules.find(m => vidToString(m.identifier) === vidScopeToString(vid))
    if (foundModule) {
        checkModule(foundModule, ctx)
        const statement = foundModule.block.statements
            .find(s => {
                const v = statementVid(s)
                return v && vidToString(v) === vid.name
            })
        if (!statement) return undefined
        const def = statementToDefinition(statement)
        if (!def) return undefined
        return { qualifiedVid: vid, def }
    }
    return undefined
}