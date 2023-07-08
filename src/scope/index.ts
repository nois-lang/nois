import { AstNode, Module } from '../ast'
import { FnDef, ImplDef } from '../ast/statement'
import { isAssignable, typeToVirtual, VirtualType } from '../typecheck'
import { Definition, VirtualIdentifier } from './vid'
import { Config } from '../config'

export interface Context {
    config: Config
    moduleStack: Module[]
    modules: Module[]
    errors: SemanticError[]
    warnings: SemanticError[]
}

export type ScopeType = 'module' | 'fn-def' | 'kind-def' | 'type-def' | 'block'

export interface Scope {
    type: ScopeType
    definitions: Map<string, Definition>
}

export interface SemanticError {
    module: Module,
    node: AstNode<any>
    message: string
}

export const semanticError = (ctx: Context, node: AstNode<any>, message: string): SemanticError =>
    ({ module: ctx.moduleStack.at(-1)!, node, message })

export const findImpl = (vId: VirtualIdentifier, type: VirtualType, ctx: Context): ImplDef | undefined => {
    // TODO: go through imports only
    return ctx.modules
        .flatMap(m => m.block.statements.filter(s => s.kind === 'impl-def').map(s => <ImplDef>s))
        .filter(i => !i.forKind || isAssignable(type, typeToVirtual(i.forKind), ctx))
        .find(i => i.name.value === vId.name)
}

export const findImplFn = (implDef: ImplDef, vid: VirtualIdentifier, ctx: Context): FnDef | undefined => {
    return implDef.block.statements
        .filter(s => s.kind === 'fn-def' && s.name.value === vid.name)
        .map(s => <FnDef>s).at(0)
}

export const pathToVid = (path: string, packageName?: string): VirtualIdentifier => {
    const dirs = path.replace(/\.no$/, '').split('/')
    if (packageName) {
        dirs.unshift(packageName)
    }
    if (dirs.at(-1)!.toLowerCase() === 'index') {
        dirs.pop()
    }
    const scope = dirs.slice(0, -1)
    const name = dirs.at(-1)!
    return { scope, name }
}
