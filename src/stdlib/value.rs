use std::collections::HashMap;
use std::rc::Rc;

use crate::ast::ast_pair::AstPair;
use crate::error::Error;
use crate::interpret::context::Context;
use crate::interpret::value::Value;
use crate::stdlib::lib::{arg_error, arg_values, LibFunction, Package};

pub fn package() -> Package {
    let mut defs = HashMap::new();
    [Type::definitions(), To::definitions()]
        .into_iter()
        .for_each(|d| defs.extend(d));
    Package {
        name: "value".to_string(),
        definitions: defs,
    }
}

pub struct Type;

impl LibFunction for Type {
    fn name() -> Vec<String> {
        vec!["type".to_string()]
    }

    fn call(args: &[AstPair<Rc<Value>>], ctx: &mut Context) -> Result<Value, Error> {
        let arg = match arg_values(args)[..] {
            [a] => a.clone(),
            _ => return Err(arg_error("(*)", args, ctx)),
        };
        Ok(arg.value_type())
    }
}

pub struct To;

impl LibFunction for To {
    fn name() -> Vec<String> {
        vec!["to".to_string()]
    }

    fn call(args: &[AstPair<Rc<Value>>], ctx: &mut Context) -> Result<Value, Error> {
        let is_type_list = |l: &Vec<Value>| matches!(l[..], [Value::Type(..)]);
        let (arg, vt) = match arg_values(args)[..] {
            [a, vt @ Value::Type(..)] => (a.clone(), vt.clone()),
            [a, vt @ Value::List { items, .. }] if is_type_list(items) => (a.clone(), vt.clone()),
            _ => return Err(arg_error("(*, T)", args, ctx)),
        };
        arg.to(&vt).ok_or_else(|| {
            Error::from_callee(
                ctx,
                format!(
                    "unable to cast value {} from {} to {}",
                    arg,
                    arg.value_type(),
                    vt
                ),
            )
        })
    }
}
