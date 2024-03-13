import { AstNode, Module, Param } from '../ast'
import { Identifier, Name, Operand } from '../ast/operand'
import { Block, BreakStmt, FnDef, ImplDef, ReturnStmt, Statement, TraitDef, VarDef } from '../ast/statement'
import { Generic, Type } from '../ast/type'
import { TypeDef, Variant } from '../ast/type-def'
import {
    BlockScope,
    Context,
    DefinitionMap,
    FnDefScope,
    InstanceScope,
    TypeDefScope,
    addError,
    addWarning,
    defKey,
    fnDefScope,
    instanceScope,
    unwindScope
} from '../scope'
import { InstanceRelation, findSuperRelChains, traitDefToVirtualType } from '../scope/trait'
import { idToVid, vidEq, vidToString } from '../scope/util'
import { Definition, MethodDef, NameDef, VirtualIdentifierMatch, resolveVid, typeKinds } from '../scope/vid'
import { VirtualType, genericToVirtual, isAssignable, typeEq, typeToVirtual } from '../typecheck'
import { instanceGenericMap, makeGenericMapOverStructure, resolveType } from '../typecheck/generic'
import { holeType, neverType, selfType, unitType, unknownType } from '../typecheck/type'
import { assert, todo } from '../util/todo'
import { notFoundError, semanticError, typeError, unknownTypeError } from './error'
import { checkClosureExpr, checkExpr } from './expr'
import { checkPattern } from './match'
import { typeNames } from './type-def'
import { Upcast, makeUpcastMap, upcast } from './upcast'
import { VirtualUseExpr, useExprToVids } from './use-expr'

export interface Checked {
    checked: boolean
}

export interface Typed {
    type: VirtualType
}

export interface Static {
    impl: InstanceRelation
}

export interface Virtual {
    upcasts: Map<string, Upcast>
}

export const prepareModule = (module: Module): void => {
    const defMap: DefinitionMap = new Map()
    module.block.statements.map(s => {
        switch (s.kind) {
            case 'fn-def':
            case 'trait-def':
            case 'type-def':
                defMap.set(defKey(s), s)
                break
            case 'var-def':
                switch (s.pattern.expr.kind) {
                    case 'name':
                        const nameDef: NameDef = { kind: 'name-def', name: s.pattern.expr, parent: s }
                        defMap.set(defKey(nameDef), nameDef)
                        break
                    case 'hole':
                        break
                    default:
                        todo(`top level \`${s.pattern.kind}\``)
                        break
                }
                break
            case 'impl-def':
            case 'operand-expr':
            case 'unary-expr':
            case 'binary-expr':
            case 'return-stmt':
                break
        }
    })
    module.topScope = { kind: 'module', definitions: defMap }

    module.references = module.useExprs.filter(e => !e.pub).flatMap(e => useExprToVids(e))
    module.reExports = module.useExprs.filter(e => e.pub).flatMap(e => useExprToVids(e))
}

export const checkModule = (module: Module, ctx: Context): void => {
    assert(!!module.topScope, 'module top scope is not set')
    if (ctx.moduleStack.find(m => vidEq(m.identifier, module.identifier))) {
        const vid = vidToString(module.identifier)
        const stackVids = ctx.moduleStack.map(m => vidToString(m.identifier))
        const refChain = [...stackVids.slice(stackVids.indexOf(vid)), vid].join(' -> ')
        addError(ctx, semanticError(ctx, module, `circular module reference: ${refChain}`))
        return
    }
    ctx.moduleStack.push(module)

    const resolvedRefs = []
    for (const useExpr of module.references!) {
        const ref = checkUseExpr(useExpr, ctx)
        if (!ref) continue
        const name = <Name>useExpr.useExpr.expr
        if (resolvedRefs.filter(e => vidEq(e.vid, ref.vid)).length > 0) {
            // TODO: reference first occurence
            addWarning(ctx, semanticError(ctx, name, `duplicate import`))
            continue
        }
        if (ref.module === module) {
            addWarning(ctx, semanticError(ctx, name, `unnecessary self import`))
            continue
        }
        resolvedRefs.push({ vid: ref.vid, useExpr: useExpr.useExpr })
    }
    module.references = resolvedRefs

    for (const reExport of module.reExports!) {
        checkUseExpr(reExport, ctx)
    }

    checkBlock(module.block, ctx)
    ctx.moduleStack.pop()
}

export const checkUseExpr = (useExpr: VirtualUseExpr, ctx: Context): VirtualIdentifierMatch<Definition> | undefined => {
    const pkgName = useExpr.vid.names[0]
    if (!ctx.packages.some(pkg => pkg.name === pkgName)) {
        addError(ctx, notFoundError(ctx, useExpr.useExpr.scope[0], pkgName, 'package'))
        return undefined
    }
    const name = <Name>useExpr.useExpr.expr
    const ref = resolveVid(useExpr.vid, ctx)
    if (!ref) {
        addError(ctx, notFoundError(ctx, name, vidToString(useExpr.vid)))
        return undefined
    }
    return ref
}

/*
 * Can be called outside of scope, module's own scope stack is preserved
 */
export const checkTopLevelDefinition = (module: Module, definition: Definition, ctx: Context): void => {
    assert(!!module.topScope, 'module top scope is not set')
    ctx.moduleStack.push(module)
    // since this can be called while module is still being checked and has state, it should be preserved
    const oldStack = module.scopeStack
    module.scopeStack = [module.topScope!]

    switch (definition.kind) {
        case 'variant':
            checkTypeDef(definition.typeDef, ctx)
            break
        case 'method-def':
            checkStatement(definition.fn, ctx)
            break
        case 'name-def':
            if (definition.parent) {
                checkStatement(definition.parent, ctx)
            }
            break
        case 'generic':
        case 'module':
        case 'self':
            break
        default:
            checkStatement(definition, ctx)
            break
    }

    module.scopeStack = oldStack
    ctx.moduleStack.pop()
}

export const checkBlock = (block: Block, ctx: Context): boolean => {
    const module = ctx.moduleStack.at(-1)!
    const scope: BlockScope = { kind: 'block', definitions: new Map(), isLoop: false, allBranchesReturned: false }
    module.scopeStack.push(scope)

    // TODO: check for unreachable statements after return statement or fns returning `Never`
    for (const s of block.statements) {
        if (scope.allBranchesReturned) {
            addWarning(ctx, semanticError(ctx, s, `unreachable statement`))
        }

        checkStatement(s, ctx)

        if (
            s.kind === 'return-stmt' ||
            s.kind === 'break-stmt' ||
            ('type' in s && s.type?.kind === 'vid-type' && vidEq(s.type.identifier, neverType.identifier))
        ) {
            scope.allBranchesReturned = true
        }
    }

    if (scope.allBranchesReturned) {
        block.type = neverType
    } else {
        const lastStatement = block.statements.at(-1)
        block.type = lastStatement && 'type' in lastStatement ? lastStatement.type : unitType
        if (
            module.scopeStack.at(-2)?.kind === 'fn' &&
            lastStatement &&
            (lastStatement.kind === 'operand-expr' ||
                lastStatement.kind === 'unary-expr' ||
                lastStatement.kind === 'binary-expr')
        ) {
            fnDefScope(ctx)?.returns.push(lastStatement)
        }
    }

    module.scopeStack.pop()

    return scope.allBranchesReturned
}

const checkStatement = (statement: Statement, ctx: Context): void => {
    const module = ctx.moduleStack.at(-1)!
    const scope = module.scopeStack.at(-1)!
    const topLevel = module.scopeStack.length === 1

    if (topLevel && !['var-def', 'fn-def', 'trait-def', 'impl-def', 'type-def'].includes(statement.kind)) {
        addError(ctx, semanticError(ctx, statement, `top level \`${statement.kind}\` is not allowed`))
        return
    }
    if (['impl-def', 'trait-def'].includes(scope.kind) && statement.kind !== 'fn-def') {
        addError(ctx, semanticError(ctx, statement, `\`${statement.kind}\` in instance scope is not allowed`))
        return
    }

    const pushDefToStack = (def: Definition) => {
        scope.definitions.set(defKey(def), def)
    }

    switch (statement.kind) {
        case 'var-def':
            checkVarDef(statement, ctx)
            break
        case 'fn-def':
            checkFnDef(statement, ctx)
            pushDefToStack(statement)
            break
        case 'trait-def':
            checkTraitDef(statement, ctx)
            pushDefToStack(statement)
            break
        case 'impl-def':
            checkImplDef(statement, ctx)
            pushDefToStack(statement)
            break
        case 'type-def':
            checkTypeDef(statement, ctx)
            pushDefToStack(statement)
            // variants are accessible from the module scope
            statement.variants.forEach(v => {
                pushDefToStack({ kind: 'variant', variant: v, typeDef: statement })
            })
            break
        case 'operand-expr':
        case 'unary-expr':
        case 'binary-expr':
            checkExpr(statement, ctx)
            break
        case 'return-stmt':
            checkReturnStmt(statement, ctx)
            break
        case 'break-stmt':
            checkBreakStmt(statement, ctx)
            break
    }
}

const checkFnDef = (fnDef: FnDef, ctx: Context): void => {
    if (fnDef.checked) return
    if (ctx.check) {
        fnDef.checked = true
    }
    const module = ctx.moduleStack.at(-1)!
    const fnScope: FnDefScope = {
        kind: 'fn',
        definitions: new Map(fnDef.generics.map(g => [defKey(g), g])),
        def: fnDef,
        returns: []
    }
    module.scopeStack.push(fnScope)

    const paramTypes = fnDef.params.map((p, i) => {
        checkParam(p, i, ctx)
        return p.type!
    })
    const firstParam = paramTypes.at(0)
    fnDef.static = !(firstParam?.kind === 'generic' && firstParam.name === selfType.name)

    if (fnDef.returnType) {
        checkType(fnDef.returnType, ctx)
    }

    const returnType = fnDef.returnType ? typeToVirtual(fnDef.returnType, ctx) : unitType
    fnDef.type = {
        kind: 'fn-type',
        generics: fnDef.generics.map(g => genericToVirtual(g, ctx)),
        paramTypes,
        returnType
    }

    const instScope = instanceScope(ctx)
    const genericMaps = instScope ? [instanceGenericMap(instScope, ctx)] : []
    const returnTypeResolved = resolveType(returnType, genericMaps, ctx)

    if (ctx.check && !module.compiled) {
        if (fnDef.block) {
            checkBlock(fnDef.block, ctx)
            fnScope.returns.forEach(rs => {
                if (!isAssignable(rs.type!, returnTypeResolved, ctx)) {
                    addError(ctx, typeError(rs, rs.type!, returnTypeResolved, ctx))
                }
                upcast(rs, rs.type!, returnTypeResolved, ctx)
            })
        } else {
            if (!module.compiled && instScope?.rel.instanceDef.kind !== 'trait-def') {
                const msg = `fn \`${fnDef.name.value}\` has no body -> must be native`
                addWarning(ctx, semanticError(ctx, fnDef.name, msg))
            }
            if (instScope?.rel.instanceDef.kind === 'trait-def' && fnDef.pub) {
                const msg = `trait method \`${fnDef.name.value}\` is always public`
                addWarning(ctx, semanticError(ctx, fnDef.name, msg))
            }
        }
    }

    module.scopeStack.pop()
}

export const checkParam = (param: Param, index: number, ctx: Context): void => {
    const instScope = instanceScope(ctx)

    if (!param.paramType) {
        if (index === 0 && instScope && param.pattern.expr.kind === 'name' && param.pattern.expr.value === 'self') {
            param.type = selfType
        } else {
            addError(ctx, semanticError(ctx, param, 'parameter type not specified'))
            param.type = unknownType
        }
    } else {
        checkType(param.paramType, ctx)
        if (
            instScope &&
            param.paramType.kind === 'identifier' &&
            param.paramType.names.at(-1)!.value === selfType.name
        ) {
            param.type = selfType
        } else {
            param.type = typeToVirtual(param.paramType, ctx)
        }
    }

    switch (param.pattern.expr.kind) {
        case 'operand-expr':
        case 'unary-expr':
        case 'binary-expr':
            addError(
                ctx,
                semanticError(ctx, param.pattern, `\`${param.pattern.kind}\` can only be used in match expressions`)
            )
            break
        default:
            checkPattern(param.pattern, param.type, ctx)
            break
    }
}

const checkTraitDef = (traitDef: TraitDef, ctx: Context) => {
    // TODO: should any errors be reported?
    const rel = ctx.impls.find(i => i.instanceDef === traitDef)
    if (!rel) return

    const module = ctx.moduleStack.at(-1)!

    if (instanceScope(ctx)) {
        addError(ctx, semanticError(ctx, traitDef, `trait definition within instance scope`))
        return
    }

    const scope: InstanceScope = {
        kind: 'instance',
        selfType: rel.forType,
        rel,
        definitions: new Map(traitDef.generics.map(g => [defKey(g), g]))
    }
    module.scopeStack.push(scope)

    checkBlock(traitDef.block, ctx)
    // TODO: make sure method signature matches with its trait

    module.scopeStack.pop()
}

const checkImplDef = (implDef: ImplDef, ctx: Context) => {
    // TODO: should any errors be reported?
    const rel = ctx.impls.find(i => i.instanceDef === implDef)
    if (!rel) return

    const module = ctx.moduleStack.at(-1)!

    if (instanceScope(ctx)) {
        addError(ctx, semanticError(ctx, implDef, 'impl definition within instance scope'))
        return
    }

    const scope: InstanceScope = {
        kind: 'instance',
        selfType: rel.forType,
        rel,
        definitions: new Map(implDef.generics.map(g => [defKey(g), g]))
    }
    module.scopeStack.push(scope)

    checkBlock(implDef.block, ctx)

    checkType(implDef.identifier, ctx)

    if (implDef.forTrait) {
        checkType(implDef.forTrait, ctx)

        const vid = idToVid(implDef.identifier)
        const ref = resolveVid(vid, ctx, ['type-def', 'trait-def'])
        if (ref) {
            if (module.compiled) {
            } else if (ref.def.kind === 'trait-def') {
                const traitRels = [
                    ctx.impls.find(rel => rel.instanceDef === ref.def)!,
                    ...findSuperRelChains(ref.vid, ctx).flatMap(chain => chain)
                ]
                const traitMethods: MethodDef[] = traitRels.flatMap(t => {
                    const methods = <FnDef[]>t.instanceDef.block.statements.filter(s => s.kind === 'fn-def')
                    return methods.map(m => ({ kind: 'method-def', rel: t, fn: m }))
                })
                const requiredImplMethods = traitMethods.filter(f => !f.fn.block)
                const implMethods = implDef.block.statements.filter(s => s.kind === 'fn-def').map(s => <FnDef>s)
                for (const m of requiredImplMethods) {
                    const mName = m.fn.name.value
                    if (!implMethods.find(im => im.name.value === mName)) {
                        const msg = `missing method implementation \`${vidToString(ref.vid)}::${mName}\``
                        addError(ctx, semanticError(ctx, implDef.identifier.names.at(-1)!, msg))
                    }
                }
                for (const m of implMethods) {
                    const mName = m.name.value
                    const traitMethod = traitMethods.find(im => im.fn.name.value === mName)
                    if (!traitMethod) {
                        const msg = `method \`${vidToString(ref.vid)}::${mName}\` is not defined by implemented trait`
                        addError(ctx, semanticError(ctx, m.name, msg))
                        continue
                    }
                    checkTopLevelDefinition(traitMethod.rel.module, traitMethod.rel.instanceDef, ctx)

                    const traitMap = makeGenericMapOverStructure(rel.implType, traitMethod.rel.implType)
                    const mResolvedType = resolveType(traitMethod.fn.type!, [traitMap], ctx)
                    if (!(isAssignable(m.type!, mResolvedType, ctx) && typeEq(m.type!, mResolvedType))) {
                        addError(ctx, typeError(m.name, m.type!, mResolvedType, ctx))
                    }
                }
                implDef.superMethods = traitMethods.filter(
                    m => m.fn.block && !implMethods.find(im => im.name.value === m.fn.name.value)
                )
                implDef.superMethods.forEach(m => checkTopLevelDefinition(m.rel.module, m.rel.instanceDef, ctx))
                for (const m of implDef.superMethods) {
                    m.paramUpcasts = m.fn.params.map(p => {
                        const genericMaps = [makeGenericMapOverStructure(rel.forType, p.type!)]
                        const resolvedType = resolveType(p.type!, genericMaps, ctx)
                        return makeUpcastMap(resolvedType, m.rel.forType, ctx)
                    })
                }
                module.relImports.push(...implDef.superMethods.map(i => i.rel))
            } else {
                addError(ctx, semanticError(ctx, implDef.forTrait, `expected \`trait-def\`, got \`${ref.def.kind}\``))
            }
        } else {
            addError(ctx, notFoundError(ctx, implDef.forTrait, vidToString(vid)))
        }

        // TODO: check that bounded traits are implemented by type,
        // e.g. `impl Ord for Foo` requires `impl Eq for Foo` since `trait Ord<Self: Eq>`
    }

    module.scopeStack.pop()
}

export const checkTypeDef = (typeDef: TypeDef, ctx: Context) => {
    if (typeDef.checked) return
    typeDef.checked = true

    const module = ctx.moduleStack.at(-1)!

    const vid = { names: [...module.identifier.names, typeDef.name.value] }
    const definitions = new Map(typeDef.generics.map(g => [defKey(g), g]))
    module.scopeStack.push({ kind: 'type', def: typeDef, vid, definitions })

    typeDef.variants.forEach(v => checkVariant(v, ctx))
    // TODO: check duplicate variants

    module.scopeStack.pop()
}

const checkVariant = (variant: Variant, ctx: Context) => {
    if (variant.type) return

    const module = ctx.moduleStack.at(-1)!
    const typeDefScope = <TypeDefScope>module.scopeStack.at(-1)!
    variant.fieldDefs.forEach(fieldDef => {
        checkType(fieldDef.fieldType, ctx)
        fieldDef.type = typeToVirtual(fieldDef.fieldType, ctx)
        // TODO: check duplicate field defs
    })

    const generics = [...typeDefScope.definitions.values()].map(d => <Generic>d).map(g => genericToVirtual(g, ctx))

    // names used in fieldDef, needed to match what typeDef generics are being used
    const names = variant.fieldDefs.flatMap(f => typeNames(f.fieldType))
    // unused generics needs to be replaced with `_` because some variants ignore type def generics,
    // e.g. `Option::None()` should have type of `||: Option<_>`
    const typeArgs = generics.map(g => (names.includes(g.name) ? g : holeType))

    variant.type = {
        kind: 'fn-type',
        paramTypes: variant.fieldDefs.map(f => typeToVirtual(f.fieldType, ctx)),
        returnType: { kind: 'vid-type', identifier: typeDefScope.vid, typeArgs },
        generics
    }
}

/**
 * TODO: resolve hole types in varDef.varType
 */
const checkVarDef = (varDef: VarDef, ctx: Context): void => {
    if (varDef.checked) return
    varDef.checked = true

    const module = ctx.moduleStack.at(-1)!
    const topLevel = module.scopeStack.length === 1

    if (topLevel && !varDef.varType) {
        addError(ctx, semanticError(ctx, varDef, `top level \`${varDef.kind}\` must have explicit type`))
        return
    }
    if (topLevel && !module.compiled && !varDef.expr) {
        addError(ctx, semanticError(ctx, varDef, `top level \`${varDef.kind}\` must be defined`))
        return
    }

    let varType: VirtualType | undefined

    if (varDef.varType) {
        checkType(varDef.varType, ctx)
        const instScope = instanceScope(ctx)
        varType = resolveType(
            typeToVirtual(varDef.varType, ctx),
            instScope ? [instanceGenericMap(instScope, ctx)] : [],
            ctx
        )
    }

    if (varDef.expr) {
        checkExpr(varDef.expr, ctx)

        if (varType) {
            const exprType = varDef.expr.type!
            if (!isAssignable(exprType, varType, ctx)) {
                addError(ctx, typeError(varDef, exprType, varType, ctx))
            }
        } else {
            if (varDef.expr.type!.kind === 'unknown-type') {
                addError(ctx, unknownTypeError(varDef.expr, varDef.expr.type!, ctx))
                varType = unknownType
            } else {
                varType = varDef.expr.type
            }
        }
    }

    checkPattern(varDef.pattern, varType!, ctx)
}

export const checkReturnStmt = (returnStmt: ReturnStmt, ctx: Context) => {
    const scope = fnDefScope(ctx)

    if (!scope) {
        addError(ctx, semanticError(ctx, returnStmt, `\`${returnStmt.kind}\` outside of the function scope`))
    }

    checkExpr(returnStmt.returnExpr, ctx)
    returnStmt.type = returnStmt.returnExpr.type

    scope?.returns.push(returnStmt.returnExpr)
}

export const checkBreakStmt = (breakStmt: BreakStmt, ctx: Context) => {
    const scopes = unwindScope(ctx)
    const loopScopeExists = scopes.some(s => s.kind === 'block' && s.isLoop)
    if (loopScopeExists) {
        for (const scope of scopes) {
            if (scope.kind === 'fn') {
                addError(ctx, semanticError(ctx, breakStmt, 'cannot break from within the closure'))
                return
            }
            if (scope.kind === 'block' && scope.isLoop) {
                return
            }
        }
    } else {
        addError(ctx, semanticError(ctx, breakStmt, `\`${breakStmt.kind}\` outside of the loop`))
    }
}

export const checkIdentifier = (identifier: Identifier, ctx: Context): void => {
    const vid = idToVid(identifier)
    // TODO: if absolute import, check that package is explicitly imported
    const ref = resolveVid(vid, ctx)
    if (ref) {
        identifier.ref = ref
        switch (ref.def.kind) {
            case 'self':
                identifier.type = instanceScope(ctx)!.selfType
                break
            case 'name-def':
                const name = ref.def.name
                if (
                    ref.def.parent &&
                    ref.def.parent.kind === 'var-def' &&
                    !ref.def.parent.pub &&
                    ref.module !== ctx.moduleStack.at(-1)!
                ) {
                    addError(ctx, semanticError(ctx, identifier, `variable \`${ref.def.name.value}\` is private`))
                }
                if (name.type === selfType) {
                    const instScope = instanceScope(ctx)
                    identifier.type = resolveType(name.type, instScope ? [instanceGenericMap(instScope, ctx)] : [], ctx)
                } else {
                    identifier.type = name.type
                }
                break
            case 'method-def':
                if (
                    !ref.def.fn.pub &&
                    ref.def.rel.instanceDef.kind === 'impl-def' &&
                    ref.module !== ctx.moduleStack.at(-1)!
                ) {
                    addError(ctx, semanticError(ctx, identifier, `method \`${ref.def.fn.name.value}\` is private`))
                }
                const instScope: InstanceScope = {
                    kind: 'instance',
                    selfType: unknownType,
                    rel: ref.def.rel,
                    definitions: new Map(ref.def.rel.instanceDef.generics.map(g => [defKey(g), g]))
                }
                // must be set afterwards since impl generics cannot be resolved
                instScope.selfType = traitDefToVirtualType(ref.def.rel.instanceDef, ctx)

                identifier.type = resolveType(ref.def.fn.type!, [instanceGenericMap(instScope, ctx)], ctx)
                break
            case 'variant':
                identifier.type = ref.def.variant.type
                break
            case 'fn-def':
                if (!ref.def.pub && ref.module !== ctx.moduleStack.at(-1)!) {
                    addError(ctx, semanticError(ctx, identifier, `function \`${ref.def.name.value}\` is private`))
                }
                identifier.type = ref.def.type
                break
            case 'module':
                addError(ctx, semanticError(ctx, identifier, `\`${vidToString(vid)}\` is a module`))
                identifier.type = unknownType
                break
            default:
                identifier.type = unknownType
                break
        }

        // TODO: check that type args match type params
        identifier.typeArgs.forEach(typeArg => checkType(typeArg, ctx))
    } else {
        addError(ctx, notFoundError(ctx, identifier, vidToString(vid)))
        identifier.type = unknownType
    }
}

export const checkType = (type: Type, ctx: Context) => {
    switch (type.kind) {
        case 'identifier':
            const vid = idToVid(type)
            const ref = resolveVid(vid, ctx, typeKinds)
            if (!ref) {
                addError(ctx, notFoundError(ctx, type, vidToString(vid), 'type'))
                return
            }
            const k = ref.def.kind
            if (type.typeArgs.length > 0 && (k === 'generic' || k === 'self')) {
                const msg = `\`${ref.def.kind}\` does not accept type arguments`
                addError(ctx, semanticError(ctx, type.names.at(-1)!, msg))
                return
            }
            if (k === 'type-def' || k === 'trait-def') {
                type.typeArgs.forEach(tp => checkType(tp, ctx))
                const typeParams = ref.def.generics.filter(g => g.name.value !== selfType.name)
                if (type.typeArgs.length !== typeParams.length) {
                    const msg = `expected ${typeParams.length} type arguments, got ${type.typeArgs.length}`
                    addError(ctx, semanticError(ctx, type, msg))
                    return
                }
            }
            return
        case 'type-bounds':
            type.bounds.forEach(b => checkType(b, ctx))
            return
        case 'fn-type':
            // TODO: scope for generics
            type.paramTypes.forEach(p => checkType(p, ctx))
            checkType(type.returnType, ctx)
            return
    }
}

export const checkCallArgs = (node: AstNode<any>, args: Operand[], paramTypes: VirtualType[], ctx: Context): void => {
    if (args.length !== paramTypes.length) {
        addError(ctx, semanticError(ctx, node, `expected ${paramTypes.length} arguments, got ${args.length}`))
        return
    }

    for (let i = 0; i < paramTypes.length; i++) {
        const paramType = paramTypes[i]
        const arg = args[i]
        if (arg.type?.kind === 'malleable-type' && paramType.kind === 'fn-type') {
            checkClosureExpr(arg.type.closure, ctx, node, paramType)
            arg.type = arg.type.closure.type
        }
        const argType = arg.type ?? unknownType

        if (!isAssignable(argType, paramType, ctx)) {
            addError(ctx, typeError(arg, argType, paramType, ctx))
        }

        upcast(arg, argType, paramType, ctx)
    }
}
