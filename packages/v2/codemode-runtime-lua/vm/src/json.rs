//! Boundary JSON is distinct from the checkpoint graph. Cycles are checkpointable,
//! but cannot be sent to the host. Reserved markers preserve null and empty arrays.
use piccolo::{Context, Table, Value};
use serde_json::{Map, Value as Json};
const NULL: &str = "__workflow_json_null";
const ARRAY: &str = "__workflow_json_array";

pub fn from_json<'gc>(ctx: Context<'gc>, value: &Json) -> Result<Value<'gc>, String> {
    fn convert<'gc>(
        ctx: Context<'gc>,
        value: &Json,
        depth: usize,
        left: &mut usize,
    ) -> Result<Value<'gc>, String> {
        if depth > 32 || *left == 0 {
            return Err("boundary JSON budget exceeded".into());
        }
        *left -= 1;
        Ok(match value {
            Json::Null => {
                let t = Table::new(&ctx);
                t.set(ctx, NULL, true).map_err(|e| e.to_string())?;
                Value::Table(t)
            }
            Json::Bool(v) => Value::Boolean(*v),
            Json::Number(v) => {
                let n = v.as_f64().ok_or("invalid number")?;
                if !n.is_finite() || n.abs() > 9_007_199_254_740_991.0 {
                    return Err("number outside safe boundary range".into());
                }
                if let Some(i) = v.as_i64() {
                    Value::Integer(i)
                } else {
                    Value::Number(n)
                }
            }
            Json::String(s) => Value::String(ctx.intern(s.as_bytes())),
            Json::Array(values) => {
                let t = Table::new(&ctx);
                t.set(ctx, ARRAY, true).map_err(|e| e.to_string())?;
                for (i, v) in values.iter().enumerate() {
                    t.set(ctx, (i + 1) as i64, convert(ctx, v, depth + 1, left)?)
                        .map_err(|e| e.to_string())?;
                }
                Value::Table(t)
            }
            Json::Object(values) => {
                let t = Table::new(&ctx);
                for (k, v) in values {
                    if k == NULL || k == ARRAY {
                        return Err("reserved boundary key".into());
                    }
                    t.set(
                        ctx,
                        ctx.intern(k.as_bytes()),
                        convert(ctx, v, depth + 1, left)?,
                    )
                    .map_err(|e| e.to_string())?;
                }
                Value::Table(t)
            }
        })
    }
    convert(ctx, value, 0, &mut 10000)
}

pub fn to_json(value: Value<'_>) -> Result<Json, String> {
    fn convert<'gc>(
        value: Value<'gc>,
        depth: usize,
        left: &mut usize,
        path: &mut Vec<Table<'gc>>,
    ) -> Result<Json, String> {
        if depth > 32 || *left == 0 {
            return Err("boundary JSON budget exceeded".into());
        }
        *left -= 1;
        Ok(match value {
            Value::Nil => Json::Null,
            Value::Boolean(b) => Json::Bool(b),
            Value::Integer(i) if i.unsigned_abs() <= 9_007_199_254_740_991 => serde_json::json!(i),
            Value::Number(n) if n.is_finite() && n.abs() <= 9_007_199_254_740_991.0 => {
                serde_json::json!(n)
            }
            Value::String(s) => Json::String(
                std::str::from_utf8(s.as_bytes())
                    .map_err(|_| "boundary string must be UTF-8")?
                    .into(),
            ),
            Value::Table(t) => {
                if t.metatable().is_some() || path.contains(&t) {
                    return Err("boundary has metatable or cycle".into());
                }
                path.push(t);
                let mut numeric = std::collections::BTreeMap::new();
                let mut object = Map::new();
                let mut array = false;
                let mut null = false;
                for (k, v) in t.iter() {
                    match k {
                        Value::String(s) => {
                            let key = std::str::from_utf8(s.as_bytes())
                                .map_err(|_| "boundary key must be UTF-8")?;
                            if key == ARRAY || key == NULL {
                                if !matches!(v, Value::Boolean(true)) {
                                    return Err("invalid JSON marker".into());
                                }
                                if key == ARRAY {
                                    array = true;
                                } else {
                                    null = true;
                                }
                            } else {
                                object.insert(key.into(), convert(v, depth + 1, left, path)?);
                            }
                        }
                        Value::Integer(i) if i > 0 && i <= 10000 => {
                            numeric.insert(i, convert(v, depth + 1, left, path)?);
                        }
                        _ => {
                            return Err(
                                "boundary tables require string keys or contiguous array indices"
                                    .into(),
                            )
                        }
                    }
                }
                path.pop();
                if null {
                    if array || !numeric.is_empty() || !object.is_empty() {
                        return Err("invalid null marker".into());
                    }
                    Json::Null
                } else if array || !numeric.is_empty() {
                    if !object.is_empty()
                        || numeric
                            .keys()
                            .enumerate()
                            .any(|(i, k)| *k != (i + 1) as i64)
                    {
                        return Err("mixed or sparse boundary table".into());
                    }
                    Json::Array(numeric.into_values().collect())
                } else {
                    Json::Object(object)
                }
            }
            _ => return Err("non-JSON boundary value".into()),
        })
    }
    convert(value, 0, &mut 10000, &mut Vec::new())
}
