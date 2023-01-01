#[macro_use]
extern crate pest;
#[macro_use]
extern crate pest_derive;

use crate::ast::ast_parser::parse_block;
use crate::parser::{NoisParser, Rule};
use colored::Colorize;
use pest::Parser;

pub mod ast;
pub mod parser;

fn main() {
    let source = r#"
        a = (a, b, c) {
            d = [1, 2.5, 'abc']
            print(d)
        }
    "#;
    let program = NoisParser::parse(Rule::program, source)
        .and_then(|parsed| parse_block(&parsed.into_iter().next().unwrap()));
    match program {
        Ok(p) => {
            println!("{p}")
        }
        Err(e) => {
            eprintln!("{}", e.to_string().red())
        }
    }
}
