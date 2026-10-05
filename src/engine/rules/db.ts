import type { Rule } from "../../types";

export const dbRules: Rule[] = [
  { id: "db-url", severity: "block", description: "DB connection string có password", pattern: "\\b(?:mysql|postgres|postgresql|mongodb(?:\\+srv)?|redis|rediss|mssql|amqps?|ibmdb)://[^\\s:@/\"']+:[^\\s@/\"']+@" },
  { id: "mongodb-url", severity: "block", description: "MongoDB connection string có password", pattern: "\\bmongodb(?:\\+srv)?://[^\\s:@/\"']+:[^\\s@/\"']+@" },
  { id: "jdbc-password", severity: "block", description: "JDBC URL chứa password", pattern: "jdbc:[a-z0-9]+://[^\\s]*[?;&](?:password|PWD)=[^\\s;&']+" },
  { id: "sql-connstring", severity: "warn", description: "SQL connection string chứa password", pattern: "\\b(?:[Ss][Ee][Rr][Vv][Ee][Rr]|[Dd][Aa][Tt][Aa] [Ss][Oo][Uu][Rr][Cc][Ee])=[^;]+;[^;]*[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]=[^;\\s\"]+" },
  { id: "postgres-env", severity: "warn", description: "PG password env", pattern: "\\b[Pp][Gg]\\w*[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]\\w*=\\S{6,}" },
];
