import { Module } from '../ast'
import { Name } from '../ast/operand'
import { FnDef, ImplDef, Statement, TraitDef } from '../ast/statement'
import { Generic } from '../ast/type'
import { TypeDef, Variant } from '../ast/type-def'
import { checkTopLevelDefiniton } from '../semantic'
import { selfType } from '../typecheck/type'
import { unreachable } from '../util/todo'
import { Context, Scope, instanceScope } from './index'
import { defaultImportedVids } from './std'
import { findSuperRelChains } from './trait'
import { concatVid, idToVid, vidEq, vidToString } from './util'

export interface VirtualIdentifier {
    names: string[]
}

export const defKinds = <const>[
    'module',
    'name',
    'name-def',
    'self',
    'variant',
    'fn-def',
    'generic',
    'type-def',
    'trait-def',
    'method-def',
    'impl-def'
]

export type DefinitionKind = (typeof defKinds)[number]

export type Definition =
    | Module
    | NameDef
    | FnDef
    | TraitDef
    | ImplDef
    | TypeDef
    | VariantDef
    | Generic
    | SelfDef
    | MethodDef

export interface NameDef {
    kind: 'name-def'
    name: Name
    parent?: Statement
}

export interface SelfDef {
    kind: 'self'
}

export interface VariantDef {
    kind: 'variant'
    variant: Variant
    typeDef: TypeDef
}

export interface MethodDef {
    kind: 'method-def'
    fn: FnDef
    trait: ImplDef | TraitDef
}

export interface VirtualIdentifierMatch<D = Definition> {
    vid: VirtualIdentifier
    moduleVid: VirtualIdentifier
    def: D
}

/**
 * Priority:
 *  - stack variable, e.g. Foo
 *  - import, e.g. Option, option::Option, std::option::Option, Option::Some
 *
 * Vid could be:
 *  - Definition ref, e.g. Foo
 *  - variant or TraitFn ref, e.g. Option::Some or Option::map
 *  - Mix of above with partial or full qualification, e,g. std::option::Option::Some or option::Option::Some
 *  - Module ref, e.g. std::string
 *  - generic ref, e.g. C::fromIter, where C is bounded generic in scope
 *  - `Self`
 */
export const resolveVid = (
    vid: VirtualIdentifier,
    ctx: Context,
    // exclude impl-def since it cannot be requested by vid
    ofKind: DefinitionKind[] = [
        'module',
        'name',
        'name-def',
        'self',
        'variant',
        'fn-def',
        'generic',
        'type-def',
        'trait-def',
        'method-def'
    ]
): VirtualIdentifierMatch | undefined => {
    const module = ctx.moduleStack.at(-1)!
    let ref: VirtualIdentifierMatch | undefined

    if (vidToString(vid) === selfType.name && instanceScope(ctx)) {
        return { vid, moduleVid: module.identifier, def: { kind: 'self' } }
    }

    // walk through scopes inside out
    for (let i = module.scopeStack.length - 1; i >= 0; i--) {
        ref = resolveScopeVid(vid, module.scopeStack[i], ctx, ofKind, module.identifier)
        if (ref) {
            // in case of top-level ref, qualify with module
            if (i === 0) {
                if (ctx.check) {
                    checkTopLevelDefiniton(module, ref.def, ctx)
                }
                return {
                    vid: concatVid(module.identifier, ref.vid),
                    moduleVid: module.identifier,
                    def: ref.def
                }
            }
            return ref
        }
    }

    // check in top scope
    ref = resolveScopeVid(vid, module.topScope!, ctx, ofKind, module.identifier)
    if (ref) {
        if (ctx.check) {
            checkTopLevelDefiniton(module, ref.def, ctx)
        }
        return {
            vid: concatVid(module.identifier, ref.vid),
            moduleVid: module.identifier,
            def: ref.def
        }
    }

    // check if fully qualified
    ref = resolveMatchedVid(vid, ctx, ofKind)
    if (ref) return ref

    // check if vid is partially qualified with use exprs
    const matchedUseExpr = [...module.references!, ...defaultImportedVids].find(r => r.names.at(-1)! === vid.names[0])
    if (matchedUseExpr) {
        const qualifiedVid = { names: [...matchedUseExpr.names.slice(0, -1), ...vid.names] }
        const matchedRef = resolveMatchedVid(qualifiedVid, ctx, ofKind)
        if (matchedRef) {
            return matchedRef
        }
    }

    return undefined
}

const resolveScopeVid = (
    vid: VirtualIdentifier,
    scope: Scope,
    ctx: Context,
    ofKind: DefinitionKind[],
    moduleVid: VirtualIdentifier,
    checkSuper: boolean = true
): VirtualIdentifierMatch | undefined => {
    for (let k of ofKind) {
        if (vid.names.length === 1) {
            const name = vid.names[0]
            const def = scope.definitions.get(k + name)
            if (def) {
                return { vid, moduleVid, def }
            }
        }
        if (vid.names.length === 2) {
            // resolve variant
            if (k === 'variant') {
                const [typeDefName, variantName] = vid.names
                // match type def by first vid name
                const typeDef = scope.definitions.get('type-def' + typeDefName)
                if (typeDef && typeDef.kind === 'type-def') {
                    // if matched, try to find variant with matching name
                    const variant = typeDef.variants.find(v => v.name.value === variantName)
                    if (variant) {
                        return { vid, moduleVid, def: { kind: 'variant', typeDef, variant } }
                    }
                }
            }
            // resolve trait/impl fn
            if (k === 'method-def') {
                const [traitName, fnName] = vid.names
                // match trait/impl def by first vid name
                const traitDef =
                    scope.definitions.get('trait-def' + traitName) ??
                    scope.definitions.get('impl-def' + traitName) ??
                    scope.definitions.get('type-def' + traitName)
                if (traitDef && (traitDef.kind === 'trait-def' || traitDef.kind === 'impl-def')) {
                    const module = resolveVid(moduleVid, ctx, ['module'])
                    if (module && module.def.kind === 'module') {
                        checkTopLevelDefiniton(module.def, traitDef, ctx)
                        // if matched, try to find fn with matching name in specified trait
                        const fn = traitDef.block.statements.find(s => s.kind === 'fn-def' && s.name.value === fnName)
                        if (fn && fn.kind === 'fn-def') {
                            return { vid, moduleVid: module.vid, def: { kind: 'method-def', fn, trait: traitDef } }
                        }
                    }
                }
                if (traitDef && checkSuper) {
                    // lookup supertypes' traits/impls that might contain that function
                    const fullTypeVid = { names: [...(moduleVid?.names ?? []), traitName] }
                    const superRels = findSuperRelChains(fullTypeVid, ctx).map(c => c.at(-1)!)
                    for (let superRel of superRels) {
                        // don't check itself
                        if (vidEq(fullTypeVid, superRel.implDef.vid)) continue
                        const fullMethodVid = { names: [...superRel.implDef.vid.names, fnName] }
                        const methodRef = resolveVid(fullMethodVid, ctx, ['method-def'])
                        if (methodRef && methodRef.def.kind === 'method-def') {
                            const module = resolveVid(methodRef.moduleVid, ctx, ['module'])
                            if (!module || module.def.kind !== 'module') return unreachable()
                            checkTopLevelDefiniton(module.def, methodRef.def, ctx)
                            return methodRef
                        }
                    }
                }
                // resolve generic refd fn
                const [genericName] = vid.names
                const genericDef = scope.definitions.get('generic' + genericName)
                if (genericDef && genericDef.kind === 'generic') {
                    // try to match every bound until first match
                    for (const bound of genericDef.bounds) {
                        const boundVid = idToVid(bound)
                        const fnVid: VirtualIdentifier = { names: [...boundVid.names, fnName] }
                        const boundRef = resolveVid(fnVid, ctx, ['method-def'])
                        if (boundRef) {
                            const module = resolveVid(moduleVid, ctx, ['module'])
                            if (!module || module.def.kind !== 'module') return unreachable()
                            checkTopLevelDefiniton(module.def, boundRef.def, ctx)
                            return boundRef
                        }
                    }
                }
            }
        }
    }
    return undefined
}

/**
 * Resolve fully qualified vid
 */
export const resolveMatchedVid = (
    vid: VirtualIdentifier,
    ctx: Context,
    ofKind: DefinitionKind[]
): VirtualIdentifierMatch | undefined => {
    let module: Module | undefined

    const pkg = ctx.packages.find(p => p.name === vid.names[0])
    if (!pkg) return undefined

    // if vid is module, e.g. std::option
    module = pkg.modules.find(m => vidEq(m.identifier, vid))
    if (module) {
        return { vid, moduleVid: module.identifier, def: module }
    }

    // if vid is varDef, typeDef, trait or impl, e.g. std::option::Option
    module = pkg.modules.find(m => vidEq(m.identifier, { names: vid.names.slice(0, -1) }))
    if (module) {
        const moduleLocalVid = { names: vid.names.slice(-1) }
        const ref = resolveScopeVid(moduleLocalVid, module.topScope!, ctx, ofKind, module.identifier)
        if (ref) {
            const defModule = resolveVid(ref.moduleVid, ctx, ['module'])
            if (!defModule || defModule.def.kind !== 'module') return unreachable()
            checkTopLevelDefiniton(defModule.def, ref.def, ctx)
            return { vid, moduleVid: module.identifier, def: ref.def }
        }
    }

    // if vid is a variant or a traitFn, e.g. std::option::Option::Some
    module = pkg.modules.find(m => vidEq(m.identifier, { names: vid.names.slice(0, -2) }))
    if (module) {
        const moduleLocalVid = { names: vid.names.slice(-2) }
        const ref = resolveScopeVid(moduleLocalVid, module.topScope!, ctx, ofKind, module.identifier)
        if (ref) {
            return { vid, moduleVid: module.identifier, def: ref.def }
        }
    }

    return undefined
}
