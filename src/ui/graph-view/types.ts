export type NodeStatus = "pending" | "active" | "done" | "error";

export interface GraphNode {
  id: string;
  label: string;
  type: "start" | "end" | "task" | "gateway" | "boundary";
  status: NodeStatus;
  details?: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
  taken: boolean;
}

export interface NodeBounds {
  left: number;
  right: number;
}
