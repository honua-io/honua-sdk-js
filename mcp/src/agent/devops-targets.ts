/** Host-selected runtimes and their canonical server actuators, never model-selected backends. */
export const DEVOPS_TARGETS = {
  "aws-ecs": {
    backend: "honua-aws-ecs-alb",
    terraformTarget: "ecs",
    imageVariable: "honua_image",
  },
  "aws-lambda": {
    backend: "honua-gitops-aws-lambda",
    terraformTarget: "lambda",
    imageVariable: "honua_image_uri",
  },
  "aws-eks": {
    backend: "honua-kubernetes-deployment",
    terraformTarget: "eks",
    // The EKS infrastructure root does not install the application. Its separate
    // workload handoff must verify the actual Deployment, Service and cluster identity.
    imageVariable: undefined,
  },
} as const;

export type DevOpsRuntimeKind = keyof typeof DEVOPS_TARGETS;

export function devOpsTarget(runtimeKind: DevOpsRuntimeKind = "aws-ecs") {
  if (!Object.hasOwn(DEVOPS_TARGETS, runtimeKind)) throw new Error("Unsupported private deployment runtime");
  return DEVOPS_TARGETS[runtimeKind];
}
