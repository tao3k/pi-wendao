import {
  Bool,
  Field,
  Float64,
  Int32,
  Int64,
  Schema,
  Table,
  Utf8,
  vectorFromArray,
  type DataType,
} from "apache-arrow";

export const WENDAO_ARROW_TABLE_METADATA_KEY = "wendao.table";

export type ArrowSchemaDataType = "utf8" | "int32" | "int64" | "float64" | "bool";
export type ArrowSchemaColumnMode = "exact" | "required";
export type ArrowSchemaNullabilityMode = "exact" | "ignore";

export interface ArrowSchemaColumn {
  readonly name: string;
  readonly dataType: ArrowSchemaDataType;
  readonly nullable: boolean;
}

export interface ArrowSchemaContract {
  readonly tableName: string;
  readonly columns: readonly ArrowSchemaColumn[];
  readonly requireTableMetadata: boolean;
}

export interface ArrowSchemaContractOptions {
  readonly requireTableMetadata?: boolean;
}

export interface ArrowColumnOptions {
  readonly nullable?: boolean;
}

export interface ArrowSchemaValidationOptions {
  readonly columnMode?: ArrowSchemaColumnMode;
  readonly nullability?: ArrowSchemaNullabilityMode;
  readonly requireTableMetadata?: boolean;
}

export function arrowSchemaContract(
  tableName: string,
  columns: readonly ArrowSchemaColumn[],
  options: ArrowSchemaContractOptions = {},
): ArrowSchemaContract {
  const normalizedTableName = tableName.trim();
  if (normalizedTableName.length === 0) {
    throw new Error("Arrow schema contract table name must be non-empty");
  }
  return {
    tableName: normalizedTableName,
    columns: [...columns],
    requireTableMetadata: options.requireTableMetadata ?? true,
  };
}

export function arrowColumn(
  name: string,
  dataType: ArrowSchemaDataType,
  options: ArrowColumnOptions = {},
): ArrowSchemaColumn {
  const normalizedName = name.trim();
  if (normalizedName.length === 0) {
    throw new Error("Arrow schema column name must be non-empty");
  }
  return {
    name: normalizedName,
    dataType,
    nullable: options.nullable ?? true,
  };
}

export function utf8ArrowColumn(name: string, options?: ArrowColumnOptions): ArrowSchemaColumn {
  return arrowColumn(name, "utf8", options);
}

export function int32ArrowColumn(name: string, options?: ArrowColumnOptions): ArrowSchemaColumn {
  return arrowColumn(name, "int32", options);
}

export function int64ArrowColumn(name: string, options?: ArrowColumnOptions): ArrowSchemaColumn {
  return arrowColumn(name, "int64", options);
}

export function float64ArrowColumn(name: string, options?: ArrowColumnOptions): ArrowSchemaColumn {
  return arrowColumn(name, "float64", options);
}

export function boolArrowColumn(name: string, options?: ArrowColumnOptions): ArrowSchemaColumn {
  return arrowColumn(name, "bool", options);
}

export function buildArrowSchema(
  contract: ArrowSchemaContract,
  metadata: ReadonlyMap<string, string> | Readonly<Record<string, string>> = {},
): Schema {
  const schemaMetadata = metadataToMap(metadata);
  schemaMetadata.set(WENDAO_ARROW_TABLE_METADATA_KEY, contract.tableName);
  return new Schema(
    contract.columns.map((column) =>
      Field.new({
        name: column.name,
        type: arrowDataType(column.dataType),
        nullable: column.nullable,
      }),
    ),
    schemaMetadata,
  );
}

export function tableFromArrowColumns(
  contract: ArrowSchemaContract,
  columns: Readonly<Record<string, unknown>>,
): Table {
  const table = new Table(buildArrowSchema(contract), columns as never);
  validateArrowTableSchema(table, contract);
  return table;
}

export function validateArrowTableSchema(
  table: Pick<Table, "schema">,
  contract: ArrowSchemaContract,
  options: ArrowSchemaValidationOptions = {},
): void {
  const columnMode = options.columnMode ?? "exact";
  const nullability = options.nullability ?? "exact";
  const requireTableMetadata = options.requireTableMetadata ?? contract.requireTableMetadata;
  const fields = table.schema.fields;

  if (requireTableMetadata) {
    const actualTableName = table.schema.metadata.get(WENDAO_ARROW_TABLE_METADATA_KEY);
    if (actualTableName !== contract.tableName) {
      throw new Error(
        `Arrow table schema metadata expected ${WENDAO_ARROW_TABLE_METADATA_KEY}=${contract.tableName}, got ${actualTableName ?? "<missing>"}`,
      );
    }
  }

  if (columnMode === "exact" && fields.length !== contract.columns.length) {
    throw new Error(
      `Arrow table ${contract.tableName} expected ${contract.columns.length} column(s), got ${fields.length}`,
    );
  }

  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  for (const [index, column] of contract.columns.entries()) {
    const field = columnMode === "exact" ? fields[index] : fieldsByName.get(column.name);
    if (field === undefined) {
      throw new Error(`Arrow table ${contract.tableName} is missing column ${column.name}`);
    }
    if (field.name !== column.name) {
      throw new Error(
        `Arrow table ${contract.tableName} expected column ${index} to be ${column.name}, got ${field.name}`,
      );
    }
    const expectedType = arrowDataType(column.dataType);
    if (!arrowDataTypeMatches(field.type, column.dataType)) {
      throw new Error(
        `Arrow table ${contract.tableName} column ${column.name} expected ${expectedType.toString()}, got ${field.type.toString()}`,
      );
    }
    if (nullability === "exact" && field.nullable !== column.nullable) {
      throw new Error(
        `Arrow table ${contract.tableName} column ${column.name} expected nullable=${column.nullable}, got nullable=${field.nullable}`,
      );
    }
  }
}

export function utf8Column(values: readonly string[]) {
  return vectorFromArray([...values], new Utf8());
}

export function int32Column(values: readonly number[]) {
  return vectorFromArray([...values], new Int32());
}

export function int64Column(values: readonly (bigint | number)[]) {
  return vectorFromArray(
    values.map((value) => (typeof value === "bigint" ? value : BigInt(value))),
    new Int64(),
  );
}

export function float64Column(values: readonly number[]) {
  return vectorFromArray([...values], new Float64());
}

export function boolColumn(values: readonly boolean[]) {
  return vectorFromArray([...values], new Bool());
}

function arrowDataTypeMatches(actualType: DataType, expectedType: ArrowSchemaDataType): boolean {
  const expectedArrowType = arrowDataType(expectedType);
  if (actualType.typeId === expectedArrowType.typeId) {
    return true;
  }
  return expectedType === "utf8" && /^Dictionary<.+,\s*Utf8>$/.test(actualType.toString());
}

function arrowDataType(dataType: ArrowSchemaDataType): DataType {
  switch (dataType) {
    case "utf8":
      return new Utf8();
    case "int32":
      return new Int32();
    case "int64":
      return new Int64();
    case "float64":
      return new Float64();
    case "bool":
      return new Bool();
  }
}

function metadataToMap(
  metadata: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): Map<string, string> {
  if (metadata instanceof Map) {
    return new Map(metadata);
  }
  return new Map(Object.entries(metadata));
}
