import type { Table } from "apache-arrow";
import {
  arrowSchemaContract,
  boolArrowColumn,
  boolColumn,
  int32ArrowColumn,
  int32Column,
  tableFromArrowColumns,
  utf8ArrowColumn,
  utf8Column,
  validateArrowTableSchema,
  type ArrowSchemaContract,
} from "../arrow/schema.js";
import type { Branded, ProcessId, SourcePath } from "../types/domain.js";

export const QIANJI_WORKFLOW_CATALOG_TABLE = "qianji_workflow_catalog";

export const QIANJI_WORKFLOW_CATALOG_SCHEMA: ArrowSchemaContract = arrowSchemaContract(
  QIANJI_WORKFLOW_CATALOG_TABLE,
  [
    utf8ArrowColumn("workflow_id", { nullable: false }),
    utf8ArrowColumn("label", { nullable: false }),
    utf8ArrowColumn("description", { nullable: false }),
    utf8ArrowColumn("catalog_source", { nullable: false }),
    utf8ArrowColumn("source_path", { nullable: false }),
    utf8ArrowColumn("org_source_path", { nullable: false }),
    utf8ArrowColumn("process_id", { nullable: false }),
    utf8ArrowColumn("category", { nullable: false }),
    boolArrowColumn("qianji_lint_required", { nullable: false }),
    boolArrowColumn("has_bpmndi", { nullable: false }),
    boolArrowColumn("bpmn_js_renderable", { nullable: false }),
    int32ArrowColumn("task_count", { nullable: false }),
    utf8ArrowColumn("source_sha256", { nullable: false }),
    utf8ArrowColumn("org_sha256", { nullable: false }),
  ],
);

export type QianjiWorkflowCatalogWorkflowId = Branded<string, "QianjiWorkflowCatalogWorkflowId">;
export type QianjiWorkflowCatalogCategory = Branded<string, "QianjiWorkflowCatalogCategory">;
export type QianjiWorkflowHasBpmndi = Branded<boolean, "QianjiWorkflowHasBpmndi">;

export interface QianjiWorkflowCatalogRowDto {
  readonly workflowId: QianjiWorkflowCatalogWorkflowId;
  readonly label: string;
  readonly description: string;
  readonly catalogSource: string;
  readonly sourcePath: SourcePath;
  readonly orgSourcePath: SourcePath;
  readonly processId: ProcessId;
  readonly category: QianjiWorkflowCatalogCategory;
  readonly qianjiLintRequired: boolean;
  readonly hasBpmndi: QianjiWorkflowHasBpmndi;
  readonly bpmnJsRenderable: boolean;
  readonly taskCount: number;
  readonly sourceSha256: string;
  readonly orgSha256: string;
}

export function qianjiWorkflowCatalogTable(rows: readonly QianjiWorkflowCatalogRowDto[]): Table {
  return tableFromArrowColumns(QIANJI_WORKFLOW_CATALOG_SCHEMA, {
    workflow_id: utf8Column(rows.map((row) => row.workflowId)),
    label: utf8Column(rows.map((row) => row.label)),
    description: utf8Column(rows.map((row) => row.description)),
    catalog_source: utf8Column(rows.map((row) => row.catalogSource)),
    source_path: utf8Column(rows.map((row) => row.sourcePath)),
    org_source_path: utf8Column(rows.map((row) => row.orgSourcePath)),
    process_id: utf8Column(rows.map((row) => row.processId)),
    category: utf8Column(rows.map((row) => row.category)),
    qianji_lint_required: boolColumn(rows.map((row) => row.qianjiLintRequired)),
    has_bpmndi: boolColumn(rows.map((row) => row.hasBpmndi)),
    bpmn_js_renderable: boolColumn(rows.map((row) => row.bpmnJsRenderable)),
    task_count: int32Column(rows.map((row) => row.taskCount)),
    source_sha256: utf8Column(rows.map((row) => row.sourceSha256)),
    org_sha256: utf8Column(rows.map((row) => row.orgSha256)),
  });
}

export function qianjiWorkflowCatalogRowsFromTable(table: Table): QianjiWorkflowCatalogRowDto[] {
  validateArrowTableSchema(table, QIANJI_WORKFLOW_CATALOG_SCHEMA);
  const columns = {
    workflowId: requiredColumn(table, "workflow_id"),
    label: requiredColumn(table, "label"),
    description: requiredColumn(table, "description"),
    catalogSource: requiredColumn(table, "catalog_source"),
    sourcePath: requiredColumn(table, "source_path"),
    orgSourcePath: requiredColumn(table, "org_source_path"),
    processId: requiredColumn(table, "process_id"),
    category: requiredColumn(table, "category"),
    qianjiLintRequired: requiredColumn(table, "qianji_lint_required"),
    hasBpmndi: requiredColumn(table, "has_bpmndi"),
    bpmnJsRenderable: requiredColumn(table, "bpmn_js_renderable"),
    taskCount: requiredColumn(table, "task_count"),
    sourceSha256: requiredColumn(table, "source_sha256"),
    orgSha256: requiredColumn(table, "org_sha256"),
  };
  const rows: QianjiWorkflowCatalogRowDto[] = [];
  for (let index = 0; index < table.numRows; index += 1) {
    rows.push({
      workflowId: String(columns.workflowId.get(index)),
      label: String(columns.label.get(index)),
      description: String(columns.description.get(index)),
      catalogSource: String(columns.catalogSource.get(index)),
      sourcePath: String(columns.sourcePath.get(index)),
      orgSourcePath: String(columns.orgSourcePath.get(index)),
      processId: String(columns.processId.get(index)),
      category: String(columns.category.get(index)),
      qianjiLintRequired: Boolean(columns.qianjiLintRequired.get(index)),
      hasBpmndi: Boolean(columns.hasBpmndi.get(index)),
      bpmnJsRenderable: Boolean(columns.bpmnJsRenderable.get(index)),
      taskCount: Number(columns.taskCount.get(index)),
      sourceSha256: String(columns.sourceSha256.get(index)),
      orgSha256: String(columns.orgSha256.get(index)),
    });
  }
  return rows;
}

function requiredColumn(table: Table, name: string) {
  const column = table.getChild(name);
  if (!column) {
    throw new Error(`Qianji workflow catalog table is missing column ${name}`);
  }
  return column;
}
