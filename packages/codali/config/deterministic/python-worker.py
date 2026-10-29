"""Typed deterministic operations. Launched by Codali in an offline OS sandbox."""
import ast
import json
import math
import os
import re
import sys
import decimal
import importlib.metadata

if sys.platform == "linux":
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (6, 6))

os.environ["POLARS_MAX_THREADS"] = "2"
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["OPENBLAS_NUM_THREADS"] = "1"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def name(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", value), "Invalid identifier")
    return value


def expression(text, symbols, kind):
    # Construct library nodes directly. SymPy parse_expr/sympify and Python eval
    # are deliberately never used on model-supplied strings.
    require(isinstance(text, str) and 0 < len(text) <= 4000, "Expression length out of range")
    tree = ast.parse(text, mode="eval")
    require(sum(1 for _ in ast.walk(tree)) <= 256, "Expression exceeds node limit")
    if kind == "sympy":
        import sympy as lib
        functions = {n: getattr(lib, n) for n in ["sin", "cos", "tan", "exp", "log", "sqrt", "Abs"]}
        constants = {"pi": lib.pi, "E": lib.E}
    else:
        import z3 as lib
        functions = {"And": lib.And, "Or": lib.Or, "Not": lib.Not, "Implies": lib.Implies, "If": lib.If, "Distinct": lib.Distinct}
        constants = {}

    def visit(node, depth=0):
        require(depth < 32, "Expression depth exceeded")
        recur = lambda n: visit(n, depth + 1)
        if isinstance(node, ast.Constant):
            if type(node.value) is bool and kind == "z3":
                return lib.BoolVal(node.value)
            require(type(node.value) in (int, float) and math.isfinite(node.value) and abs(node.value) <= 10**100, "Only finite numeric literals are supported")
            literal = ast.get_source_segment(text, node).replace("_", "")
            return lib.Rational(literal) if kind == "sympy" else (lib.IntVal(literal) if type(node.value) is int else lib.RealVal(literal))
        if isinstance(node, ast.Name):
            require(node.id in symbols or node.id in constants, "Undeclared symbol: " + node.id)
            return symbols[node.id] if node.id in symbols else constants[node.id]
        if isinstance(node, ast.UnaryOp):
            val = recur(node.operand)
            if isinstance(node.op, ast.USub): return -val
            if isinstance(node.op, ast.UAdd): return val
            if isinstance(node.op, ast.Not) and kind == "z3": return lib.Not(val)
        if isinstance(node, ast.BinOp):
            left, right = recur(node.left), recur(node.right)
            if isinstance(node.op, ast.Add): return left + right
            if isinstance(node.op, ast.Sub): return left - right
            if isinstance(node.op, ast.Mult): return left * right
            if isinstance(node.op, ast.Div): return left / right
            if isinstance(node.op, ast.Mod) and kind == "z3": return left % right
            if isinstance(node.op, ast.Pow):
                require(isinstance(node.right, ast.Constant) and type(node.right.value) is int and 0 <= node.right.value <= 100, "Power requires a literal integer 0..100")
                return left ** right
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            require(node.func.id in functions and not node.keywords and 1 <= len(node.args) <= 32, "Unsupported function or arguments")
            return functions[node.func.id](*[recur(arg) for arg in node.args])
        if isinstance(node, ast.BoolOp) and kind == "z3":
            return (lib.And if isinstance(node.op, ast.And) else lib.Or)(*[recur(v) for v in node.values])
        if isinstance(node, ast.Compare) and kind == "z3":
            values = [recur(node.left)] + [recur(v) for v in node.comparators]
            comparisons = []
            for op, left, right in zip(node.ops, values, values[1:]):
                if isinstance(op, ast.Eq): comparisons.append(left == right)
                elif isinstance(op, ast.NotEq): comparisons.append(left != right)
                elif isinstance(op, ast.Lt): comparisons.append(left < right)
                elif isinstance(op, ast.LtE): comparisons.append(left <= right)
                elif isinstance(op, ast.Gt): comparisons.append(left > right)
                elif isinstance(op, ast.GtE): comparisons.append(left >= right)
                else: raise ValueError("Unsupported comparison")
            return lib.And(*comparisons)
        raise ValueError("Unsupported expression syntax: " + type(node).__name__)
    return visit(tree.body)


def symbolic(a):
    import sympy as s
    declared = a.get("symbols", [])
    require(isinstance(declared, list) and len(declared) <= 16, "Declare up to 16 symbols")
    symbols = {name(v): s.Symbol(v) for v in declared}
    expr = expression(a["expression"], symbols, "sympy")
    op = a["operation"]
    if op in ("simplify", "factor", "expand"):
        result = {"simplify": s.simplify, "factor": s.factor, "expand": s.expand}[op](expr)
    elif op in ("differentiate", "integrate", "solve"):
        require(a.get("variable") in symbols, "Variable must be declared")
        variable = symbols[a["variable"]]
        if op == "differentiate": result = s.diff(expr, variable)
        elif op == "integrate": result = s.integrate(expr, variable)
        else:
            roots = s.solve(expr, variable)
            return {"solutions": [str(v) for v in roots], "substitutionResiduals": [str(s.simplify(expr.subs(variable, v))) for v in roots], "equation": str(expr) + " = 0", "scope": "Complex solutions under SymPy assumptions; singularities and conditional branches may need additional analysis"}
    else: raise ValueError("Unsupported symbolic operation")
    return {"result": str(result), "unevaluated": bool(result.has(s.Integral, s.Derivative)), "scope": "Exact symbolic expression; an indefinite integral omits the arbitrary additive constant"}


def constraints(a):
    import z3 as z
    require(isinstance(a["variables"], dict) and 1 <= len(a["variables"]) <= 32, "Declare 1..32 variables")
    constructors = {"Int": z.Int, "Real": z.Real, "Bool": z.Bool}
    variables = {}
    for key, value in a["variables"].items():
        require(value in constructors, "Unknown variable sort")
        variables[name(key)] = constructors[value](key)
    require(isinstance(a["constraints"], list) and 1 <= len(a["constraints"]) <= 64, "Use 1..64 constraints")
    clauses = [expression(v, variables, "z3") for v in a["constraints"]]
    require(all(z.is_bool(v) for v in clauses), "Constraints must be Boolean")
    solver = z.Solver()
    solver.set(timeout=2000, random_seed=0)
    solver.add(*clauses)
    status = solver.check()
    if status == z.unknown: return {"status": "unknown", "reason": solver.reason_unknown()}
    if status == z.unsat: return {"status": "unsat"}
    model = solver.model()
    return {"status": "sat", "model": {key: str(model.eval(v, model_completion=True)) for key, v in variables.items()},
            "constraintsVerified": all(z.is_true(model.eval(v, model_completion=True)) for v in clauses)}


def query(a):
    import duckdb as d
    # DuckDB 2 has a separate asynchronous pool; threads alone does not bound it.
    # Cap both pools before connection startup so the address-space limit holds.
    connection = d.connect(":memory:", config={"enable_external_access": "false", "autoload_known_extensions": "false", "autoinstall_known_extensions": "false", "memory_limit": "128MB", "threads": "1", "async_threads": "1", "max_temp_directory_size": "0B"})
    try:
        tables = a.get("tables", [])
        require(isinstance(tables, list) and len(tables) <= 8, "Use at most 8 input tables")
        for table in tables:
            table_name = name(table["name"])
            columns = table["columns"]
            require(isinstance(columns, dict) and 1 <= len(columns) <= 32, "Use 1..32 typed columns")
            definitions = []
            for key, value in columns.items():
                name(key)
                require(isinstance(value, str) and re.fullmatch(r"(?:VARCHAR|BIGINT|DOUBLE|BOOLEAN|DECIMAL\((?:[1-9]|[12][0-9]|3[0-8]),(?:[0-9]|[12][0-9]|3[0-8])\))", value), "Unsupported column type")
                definitions.append('"' + key + '" ' + value)
            connection.execute('CREATE TABLE "' + table_name + '" (' + ','.join(definitions) + ')')
            rows = table["rows"]
            require(isinstance(rows, list) and len(rows) <= 2000 and all(isinstance(row, list) and len(row) == len(columns) for row in rows), "Invalid table rows")
            if rows: connection.executemany('INSERT INTO "' + table_name + '" VALUES (' + ','.join('?' for _ in columns) + ')', rows)
        sql = a["sql"]
        require(isinstance(sql, str) and 0 < len(sql) <= 8000, "SQL length out of range")
        # Blocking volatile sources prevents accidental claims of reproducibility.
        require(not re.search(r"\b(random|uuid|uuidv4|uuidv7|nextval|currval|now|today|current_date|current_time|current_timestamp|transaction_timestamp|setseed|query|query_table|read_blob|read_text|glob|getenv)\b", sql, re.I), "Volatile and external sources are unavailable")
        statements = connection.extract_statements(sql)
        require(len(statements) == 1 and statements[0].type == d.StatementType.SELECT, "Exactly one SELECT statement is allowed")
        cursor = connection.execute(sql)
        columns = [{"name": item[0], "type": str(item[1])} for item in cursor.description]
        rows = cursor.fetchmany(1001)
        return {"columns": columns, "rows": rows[:1000], "truncated": len(rows) > 1000, "ordering": "Only ORDER BY establishes row order"}
    finally:
        connection.close()


def dataframe(a):
    import polars as p
    require(isinstance(a["rows"], list) and len(a["rows"]) <= 2000, "Use at most 2000 rows")
    frame = p.DataFrame(a["rows"], strict=True, infer_schema_length=None)
    require(frame.width <= 32, "Use at most 32 columns")
    steps = a["steps"]
    require(isinstance(steps, list) and len(steps) <= 16, "Use at most 16 steps")
    for step in steps:
        op = step["operation"]
        if op == "select": frame = frame.select(step["columns"])
        elif op == "sort": frame = frame.sort(step["columns"], descending=step.get("descending", False), maintain_order=True)
        elif op == "head":
            require(type(step["count"]) is int and 0 <= step["count"] <= 1000, "Head count out of range")
            frame = frame.head(step["count"])
        elif op == "filter":
            col, val = p.col(step["column"]), p.lit(step["value"])
            comparisons = {"eq": lambda: col == val, "ne": lambda: col != val, "gt": lambda: col > val, "ge": lambda: col >= val, "lt": lambda: col < val, "le": lambda: col <= val}
            require(step["comparison"] in comparisons, "Unknown comparison")
            frame = frame.filter(comparisons[step["comparison"]]())
        elif op == "aggregate":
            aggregations = step["aggregations"]
            require(isinstance(aggregations, list) and 1 <= len(aggregations) <= 16, "Use 1..16 aggregations")
            expressions = []
            for item in aggregations:
                require(item["function"] in ("sum", "mean", "min", "max", "count", "n_unique", "median", "std"), "Unsupported aggregation")
                expressions.append(getattr(p.col(item["column"]), item["function"])().alias(name(item["alias"])))
            frame = frame.group_by(step["by"], maintain_order=True).agg(expressions) if step.get("by") else frame.select(expressions)
        else: raise ValueError("Unsupported dataframe step")
    return {"rows": frame.head(1000).to_dicts(), "schema": {key: str(value) for key, value in frame.schema.items()}, "rowCount": frame.height, "truncated": frame.height > 1000}


def clean(value):
    if isinstance(value, decimal.Decimal): return str(value)
    if type(value) is int and abs(value) > 9007199254740991: return str(value)
    if isinstance(value, (list, tuple)): return [clean(v) for v in value]
    if isinstance(value, dict): return {k: clean(v) for k, v in value.items()}
    return value


try:
    with open("input.json", encoding="utf-8") as file:
        request = json.load(file)
    handlers = {"symbolic_math": (symbolic, "sympy"), "solve_constraints": (constraints, "z3-solver"), "query_data": (query, "duckdb"), "transform_data": (dataframe, "polars")}
    handler, package = handlers[request["tool"]]
    result = handler(request["args"])
    result.update(library=package, version=importlib.metadata.version(package))
    encoded = json.dumps(clean(result), allow_nan=False, separators=(",", ":"))
    require(len(encoded) <= 96000, "Result exceeds output limit")
    sys.stdout.write(encoded)
except Exception as error:
    sys.stdout.write(json.dumps({"error": str(error)[:1000]}))
