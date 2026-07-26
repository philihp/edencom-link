// PostgREST passes an .ilike() pattern straight through to SQL LIKE, so a
// user-supplied % or _ would widen the match rather than being matched
// literally. Lives here (rather than beside its first caller in the MCP
// tools) because the src/sde*.ts loaders build .ilike() filters too, and a
// loader must not import from the MCP layer.
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`)
