# scratch pad of ideas and things for the future that I want to build


## MCP stuff

### tool annotations in the spec

I want to investigate tool annontations and figure out if we can use that as a means to
allow elicit context from annotations for MCP clients in a configuration driven way

we should be able to declare an MCP tool with sweatpants in code and host it on our MCP server

but also have an MCP client package that can "self configure" the elicit context magic just from the
connection to the MCP server and reading the tool definitions possible code generating the client much
like openapi client generators work

/> `npx @sweatpants/cli generate-mcp-client -o some/path -i http://something.mcp/mcp.json`

