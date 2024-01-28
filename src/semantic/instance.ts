import { checkCallArgs, checkType } from '.'
import { BinaryExpr, OperandExpr } from '../ast/expr'
import { PosCall } from '../ast/op'
import { Identifier, Operand } from '../ast/operand'
import { Context } from '../scope'
import { getInstanceForType } from '../scope/trait'
import { vidToString } from '../scope/util'
import { MethodDef, resolveVid } from '../scope/vid'
import { VirtualFnType, VirtualType, genericToVirtual, typeToVirtual, virtualTypeToString } from '../typecheck'
import {
    makeFnGenericMap,
    makeFnTypeArgGenericMap,
    makeGenericMapOverStructure,
    resolveType
} from '../typecheck/generic'
import { selfType, unknownType } from '../typecheck/type'
import { allEqual } from '../util/array'
import { notFoundError, semanticError } from './error'
import { checkOperand } from './expr'

/**
 * TODO: differentiate call of a fn type field
 */
export const checkAccessExpr = (binaryExpr: BinaryExpr, ctx: Context): void => {
    const rOp = binaryExpr.rOperand
    if (rOp.kind === 'operand-expr' && rOp.operand.kind === 'identifier') {
        binaryExpr.type = checkFieldAccessExpr(binaryExpr, ctx)
        return
    }
    if (rOp.kind === 'unary-expr' && rOp.unaryOp.kind === 'pos-call') {
        binaryExpr.type = checkMethodCallExpr(binaryExpr.lOperand, rOp.operand, rOp.unaryOp, ctx)
        return
    }
    ctx.errors.push(semanticError(ctx, rOp, `expected field access or method call, got ${rOp.kind}`))
}

const checkFieldAccessExpr = (binaryExpr: BinaryExpr, ctx: Context): VirtualType | undefined => {
    const lOp = binaryExpr.lOperand
    const rOp = <Identifier>(<OperandExpr>binaryExpr.rOperand).operand
    checkOperand(lOp, ctx)
    // TODO: make sure no type args specified; check other identifier uses also
    if (rOp.scope.length > 0) {
        ctx.errors.push(semanticError(ctx, rOp, `expected field name`))
        return
    }
    if (!(lOp.type?.kind === 'vid-type')) {
        ctx.errors.push(
            semanticError(ctx, rOp, `expected variant type, got \`${virtualTypeToString(lOp.type ?? unknownType)}\``)
        )
        return
    }
    const typeVid = lOp.type.identifier
    const typeRef = resolveVid(typeVid, ctx, ['type-def'])
    if (!typeRef || typeRef.def.kind !== 'type-def') {
        ctx.errors.push(notFoundError(ctx, lOp, vidToString(typeVid), 'type'))
        return
    }
    const typeDef = typeRef.def
    const fieldName = rOp.name.value
    // check that every type variant has such field
    if (
        !(typeDef.variants.length > 0 && typeDef.variants.every(v => v.fieldDefs.find(f => f.name.value === fieldName)))
    ) {
        ctx.errors.push(
            semanticError(
                ctx,
                rOp,
                `field \`${fieldName}\` is not defined in all variants of type \`${vidToString(typeRef.vid)}\``
            )
        )
        return
    }
    // if field is defined in multiple variants, make sure their type is equal
    // normaly single variant types use field access, but there is no reason to restrict multiple variants sharing the
    // same field
    const typeCandidates = typeDef.variants
        .flatMap(v => v.fieldDefs.find(f => f.name.value === fieldName)?.fieldType ?? [])
        .map(t => typeToVirtual(t, ctx))
    // TODO: probably there is a better way to compare type equality
    if (!allEqual(typeCandidates.map(virtualTypeToString))) {
        ctx.errors.push(
            semanticError(
                ctx,
                rOp,
                `field \`${fieldName}\` of \`${vidToString(
                    typeRef.vid
                )}\` variants must be of the same type to be accessed`
            )
        )
        return
    }
    const fieldType = typeCandidates[0]
    const conGenericMap = makeGenericMapOverStructure(lOp.type, {
        kind: 'vid-type',
        identifier: typeRef.vid,
        typeArgs: typeRef.def.generics.map(g => genericToVirtual(g, ctx))
    })
    return resolveType(fieldType, [conGenericMap], rOp, ctx)
}

const checkMethodCallExpr = (
    lOperand: Operand,
    rOperand: Operand,
    callOp: PosCall,
    ctx: Context
): VirtualType | undefined => {
    checkOperand(lOperand, ctx)
    if (lOperand.type?.kind !== 'vid-type') {
        ctx.errors.push(
            semanticError(
                ctx,
                rOperand,
                `expected instance type, got \`${virtualTypeToString(lOperand.type ?? unknownType)}\``
            )
        )
        return undefined
    }
    if (rOperand.kind !== 'identifier' || rOperand.scope.length !== 0) {
        ctx.errors.push(semanticError(ctx, rOperand, `expected method name, got \`${rOperand.kind}\``))
        return undefined
    }
    const methodName = rOperand.name.value
    const traitFnVid = { names: [...lOperand.type.identifier.names, methodName] }
    const ref = resolveVid(traitFnVid, ctx, ['method-def'])
    if (!ref || ref.def.kind !== 'method-def') {
        ctx.errors.push(notFoundError(ctx, rOperand, vidToString(traitFnVid)))
        return
    }

    callOp.args.forEach(a => checkOperand(a, ctx))

    const fnType = <VirtualFnType>ref.def.fn.type

    // TODO: custom check for static methods
    if (fnType.paramTypes.length !== callOp.args.length + 1) {
        ctx.errors.push(
            semanticError(ctx, callOp, `expected ${fnType.paramTypes.length} arguments, got ${callOp.args.length}`)
        )
        return
    }

    // TODO: check required type args (that cannot be inferred via `resolveFnGenerics`)
    rOperand.typeArgs.forEach(typeArg => checkType(typeArg, ctx))

    const genericMaps = makeMethodGenericMaps(lOperand, rOperand, ref.def, callOp, ctx)
    const paramTypes = fnType.paramTypes.map((pt, i) => resolveType(pt, genericMaps, callOp.args.at(i) ?? callOp, ctx))
    checkCallArgs(callOp, [lOperand, ...callOp.args], paramTypes, ctx)

    return resolveType(fnType.returnType, genericMaps, rOperand, ctx)
}

const makeMethodGenericMaps = (
    lOperand: Operand,
    rOperand: Identifier,
    methodDef: MethodDef,
    callOp: PosCall,
    ctx: Context
): Map<string, VirtualType>[] => {
    const implForType = getInstanceForType(methodDef.trait, ctx)
    const implGenericMap = makeGenericMapOverStructure(lOperand.type!, implForType)
    // if Self type param is explicit, `resolveGenericsOverStructure` treats it as regular generic and interrupts
    // further mapping in `fnGenericMap`, thus should be removed
    implGenericMap.delete(selfType.name)

    const fnType = <VirtualFnType>methodDef.fn.type
    const typeArgs = rOperand.typeArgs.map(tp => typeToVirtual(tp, ctx))
    const fnTypeArgGenericMap = makeFnTypeArgGenericMap(fnType, typeArgs)
    const fnGenericMap = makeFnGenericMap(fnType, [lOperand.type!, ...callOp.args.map(a => a.type!)])

    return [implGenericMap, fnTypeArgGenericMap, fnGenericMap]
}
