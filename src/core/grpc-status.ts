/** gRPC status CANCELED. Connect reports an aborted deadline with this code. */
export const GRPC_CANCELED = 1;

/** gRPC status UNKNOWN. A service-level edit error uses this code. */
export const GRPC_UNKNOWN = 2;

/** gRPC status FAILED_PRECONDITION. A pre-1.2 server drops global-ID selectors. */
export const GRPC_FAILED_PRECONDITION = 9;

/** gRPC status UNIMPLEMENTED. The server predates the RPC. */
export const GRPC_UNIMPLEMENTED = 12;

/** gRPC status INTERNAL. A response that breaks the contract uses this code. */
export const GRPC_INTERNAL = 13;
