import { Context, semanticError } from '../scope'
import { Type, TypeParam } from '../ast/type'
import { idToVid, resolveVid, vidToString, VirtualIdentifier } from '../scope/vid'
import { todo } from '../util/todo'

export interface Identified {
    vid: VirtualIdentifier
}

export const identifyType = (type: Type, ctx: Context): void => {
    if (type.kind === 'variant-type' && type.vid) return

    switch (type.kind) {
        case 'variant-type':
            const vid = idToVid(type.identifier)
            const vidMatch = resolveVid(vid, ctx)
            if (!vidMatch) {
                ctx.errors.push(semanticError(ctx, type, `identifier ${vidToString(vid)} not found`))
                return
            }
            if (vidMatch.def.kind !== 'type-def') {
                ctx.errors.push(semanticError(ctx, type, `identifier ${vidToString(vid)} is not a type`))
                return
            }
            const typeDef = vidMatch.def
            type.vid = vidMatch.qualifiedVid
            typeDef.typeParams.forEach(tp => identifyTypeParam(tp, ctx))
            break
        case 'fn-type':
            todo('identify fn-type')
            break
    }
}

export const identifyTypeParam = (typeParam: TypeParam, ctx: Context): void => {
    if (typeParam.kind === 'variant-type' && typeParam.vid) return

    switch (typeParam.kind) {
        case 'variant-type':
        case 'fn-type':
            identifyType(typeParam, ctx)
            break
        case 'generic':
            todo('generics')
            break

    }
}
