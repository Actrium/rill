// Minimal JSON parser for reading `contracts/graphics-seams.json` — the
// authoritative graphics-seam contract this SDK is generated from / tested
// against. Shared by TWO std-side consumers of an otherwise `no_std`,
// zero-dependency crate (hence hand-rolled instead of a JSON crate):
//
//  - `build.rs` pulls it in with `include!` to generate the gpu budget
//    constants + preset ids at build time;
//  - `#[cfg(test)] mod mini_json;` lets the conformance tests
//    (`src/conformance.rs`) re-read the contract and assert the SDK's wire
//    shapes match it.
//
// It parses the full JSON grammar (objects, arrays, strings with escapes,
// numbers, booleans, null) strictly enough for a repo-controlled input:
// any malformed byte is a hard `Err`, never a silent skip.

use std::format;
use std::string::String;
use std::vec::Vec;

/// A parsed JSON value. Object entries keep source order.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    /// Parse `src` as a single JSON document (trailing garbage is an error).
    pub fn parse(src: &str) -> Result<Json, String> {
        let bytes = src.as_bytes();
        let mut pos = 0usize;
        let value = parse_value(bytes, &mut pos)?;
        skip_ws(bytes, &mut pos);
        if pos != bytes.len() {
            return Err(format!("trailing data at byte {pos}"));
        }
        Ok(value)
    }

    /// Object field lookup (`None` for non-objects / missing keys).
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// Object entries in source order (`None` for non-objects).
    pub fn entries(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Obj(entries) => Some(entries),
            _ => None,
        }
    }

    /// Array elements (`None` for non-arrays).
    pub fn items(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(items) => Some(items),
            _ => None,
        }
    }

    /// String content (`None` for non-strings).
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    /// The value as a non-negative integer, requiring it to be exactly
    /// representable (no fraction, no negative, within u64).
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Json::Num(n) if *n >= 0.0 && n.fract() == 0.0 && *n <= 9.007_199_254_740_992e15 => {
                Some(*n as u64)
            }
            _ => None,
        }
    }
}

fn skip_ws(bytes: &[u8], pos: &mut usize) {
    while let Some(b) = bytes.get(*pos) {
        match b {
            b' ' | b'\t' | b'\n' | b'\r' => *pos += 1,
            _ => break,
        }
    }
}

fn expect(bytes: &[u8], pos: &mut usize, byte: u8) -> Result<(), String> {
    if bytes.get(*pos) == Some(&byte) {
        *pos += 1;
        Ok(())
    } else {
        Err(format!(
            "expected {:?} at byte {} (found {:?})",
            byte as char,
            *pos,
            bytes.get(*pos).map(|b| *b as char)
        ))
    }
}

fn parse_value(bytes: &[u8], pos: &mut usize) -> Result<Json, String> {
    skip_ws(bytes, pos);
    match bytes.get(*pos) {
        Some(b'{') => parse_object(bytes, pos),
        Some(b'[') => parse_array(bytes, pos),
        Some(b'"') => Ok(Json::Str(parse_string(bytes, pos)?)),
        Some(b't') => parse_lit(bytes, pos, b"true", Json::Bool(true)),
        Some(b'f') => parse_lit(bytes, pos, b"false", Json::Bool(false)),
        Some(b'n') => parse_lit(bytes, pos, b"null", Json::Null),
        Some(b'-') | Some(b'0'..=b'9') => parse_number(bytes, pos),
        other => Err(format!(
            "unexpected {:?} at byte {}",
            other.map(|b| *b as char),
            *pos
        )),
    }
}

fn parse_lit(bytes: &[u8], pos: &mut usize, lit: &[u8], value: Json) -> Result<Json, String> {
    if bytes.len() >= *pos + lit.len() && &bytes[*pos..*pos + lit.len()] == lit {
        *pos += lit.len();
        Ok(value)
    } else {
        Err(format!("bad literal at byte {}", *pos))
    }
}

fn parse_object(bytes: &[u8], pos: &mut usize) -> Result<Json, String> {
    expect(bytes, pos, b'{')?;
    let mut entries = Vec::new();
    skip_ws(bytes, pos);
    if bytes.get(*pos) == Some(&b'}') {
        *pos += 1;
        return Ok(Json::Obj(entries));
    }
    loop {
        skip_ws(bytes, pos);
        let key = parse_string(bytes, pos)?;
        skip_ws(bytes, pos);
        expect(bytes, pos, b':')?;
        let value = parse_value(bytes, pos)?;
        entries.push((key, value));
        skip_ws(bytes, pos);
        match bytes.get(*pos) {
            Some(b',') => *pos += 1,
            Some(b'}') => {
                *pos += 1;
                return Ok(Json::Obj(entries));
            }
            other => {
                return Err(format!(
                    "expected ',' or '}}' at byte {} (found {:?})",
                    *pos,
                    other.map(|b| *b as char)
                ))
            }
        }
    }
}

fn parse_array(bytes: &[u8], pos: &mut usize) -> Result<Json, String> {
    expect(bytes, pos, b'[')?;
    let mut items = Vec::new();
    skip_ws(bytes, pos);
    if bytes.get(*pos) == Some(&b']') {
        *pos += 1;
        return Ok(Json::Arr(items));
    }
    loop {
        items.push(parse_value(bytes, pos)?);
        skip_ws(bytes, pos);
        match bytes.get(*pos) {
            Some(b',') => *pos += 1,
            Some(b']') => {
                *pos += 1;
                return Ok(Json::Arr(items));
            }
            other => {
                return Err(format!(
                    "expected ',' or ']' at byte {} (found {:?})",
                    *pos,
                    other.map(|b| *b as char)
                ))
            }
        }
    }
}

fn parse_string(bytes: &[u8], pos: &mut usize) -> Result<String, String> {
    expect(bytes, pos, b'"')?;
    let mut out = String::new();
    loop {
        match bytes.get(*pos) {
            None => return Err(String::from("unterminated string")),
            Some(b'"') => {
                *pos += 1;
                return Ok(out);
            }
            Some(b'\\') => {
                *pos += 1;
                match bytes.get(*pos) {
                    Some(b'"') => out.push('"'),
                    Some(b'\\') => out.push('\\'),
                    Some(b'/') => out.push('/'),
                    Some(b'b') => out.push('\u{8}'),
                    Some(b'f') => out.push('\u{c}'),
                    Some(b'n') => out.push('\n'),
                    Some(b'r') => out.push('\r'),
                    Some(b't') => out.push('\t'),
                    Some(b'u') => {
                        let hi = parse_hex4(bytes, *pos + 1)?;
                        *pos += 4;
                        let ch = if (0xd800..0xdc00).contains(&hi) {
                            // Surrogate pair: require the low half right after.
                            if bytes.get(*pos + 1) != Some(&b'\\')
                                || bytes.get(*pos + 2) != Some(&b'u')
                            {
                                return Err(String::from("lone high surrogate"));
                            }
                            let lo = parse_hex4(bytes, *pos + 3)?;
                            *pos += 6;
                            if !(0xdc00..0xe000).contains(&lo) {
                                return Err(String::from("bad low surrogate"));
                            }
                            0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
                        } else if (0xdc00..0xe000).contains(&hi) {
                            return Err(String::from("lone low surrogate"));
                        } else {
                            hi
                        };
                        out.push(char::from_u32(ch).ok_or("bad \\u escape")?);
                    }
                    other => {
                        return Err(format!("bad escape {:?}", other.map(|b| *b as char)));
                    }
                }
                *pos += 1;
            }
            Some(&b) if b < 0x20 => {
                return Err(format!("raw control byte {b:#x} in string"));
            }
            Some(_) => {
                // Copy one UTF-8 scalar (input is &str, so boundaries are valid).
                let start = *pos;
                *pos += 1;
                while bytes.get(*pos).is_some_and(|b| b & 0xc0 == 0x80) {
                    *pos += 1;
                }
                out.push_str(
                    core::str::from_utf8(&bytes[start..*pos])
                        .map_err(|e| format!("invalid utf-8 in string at byte {start}: {e}"))?,
                );
            }
        }
    }
}

fn parse_hex4(bytes: &[u8], at: usize) -> Result<u32, String> {
    if bytes.len() < at + 4 {
        return Err(String::from("truncated \\u escape"));
    }
    let mut v = 0u32;
    for &b in &bytes[at..at + 4] {
        let d = match b {
            b'0'..=b'9' => (b - b'0') as u32,
            b'a'..=b'f' => (b - b'a' + 10) as u32,
            b'A'..=b'F' => (b - b'A' + 10) as u32,
            _ => return Err(format!("bad hex digit {:?}", b as char)),
        };
        v = (v << 4) | d;
    }
    Ok(v)
}

fn parse_number(bytes: &[u8], pos: &mut usize) -> Result<Json, String> {
    let start = *pos;
    if bytes.get(*pos) == Some(&b'-') {
        *pos += 1;
    }
    while bytes
        .get(*pos)
        .is_some_and(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        *pos += 1;
    }
    let text = core::str::from_utf8(&bytes[start..*pos]).expect("ascii number slice");
    text.parse::<f64>()
        .map(Json::Num)
        .map_err(|e| format!("bad number {text:?} at byte {start}: {e}"))
}
