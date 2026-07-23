import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

import type {
  ActiveCollectionSnapshot,
  ActiveCollectionStore,
  PutVersionedObjectRequest,
  VersionedObject,
  VersionedObjectStore,
} from "./control.ts";
import {
  ACTIVE_COLLECTION_FORMAT,
  RemoteDevelopmentError,
  type ActiveCollectionRecordV1,
  type DevelopmentEnvironmentIdentityV1,
} from "./types.ts";

export class AwsS3VersionedObjectStore implements VersionedObjectStore {
  constructor(private readonly client: S3Client) {}

  async put(request: PutVersionedObjectRequest): Promise<{ readonly versionId: string }> {
    try {
      const output = await this.client.send(
        new PutObjectCommand({
          Bucket: request.bucket,
          Key: request.key,
          Body: request.bytes,
          Metadata: { ...request.metadata },
          ContentType: "application/vnd.sweatpants.development-collection+json",
          ServerSideEncryption: "AES256",
        }),
      );
      if (!output.VersionId) {
        throw new RemoteDevelopmentError(
          "object_digest_mismatch",
          "S3 publication did not return a version ID",
        );
      }
      return { versionId: output.VersionId };
    } catch (error) {
      throw mapAwsError(error, "Unable to publish the immutable collection object");
    }
  }

  async get(bucket: string, key: string, versionId: string): Promise<VersionedObject> {
    if (!versionId) {
      throw new RemoteDevelopmentError(
        "invalid_collection_manifest",
        "S3 collection reads require an exact version ID",
      );
    }
    try {
      const output = await this.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
      );
      if (output.VersionId !== versionId || !output.Body) {
        throw new RemoteDevelopmentError(
          "object_digest_mismatch",
          "S3 returned a different or empty object version",
        );
      }
      return {
        versionId: output.VersionId,
        bytes: Uint8Array.from(await output.Body.transformToByteArray()),
      };
    } catch (error) {
      if (isMissing(error)) {
        throw new RemoteDevelopmentError(
          "release_expired",
          "Exact collection object version is unavailable",
        );
      }
      throw mapAwsError(error, "Unable to read the exact collection object version");
    }
  }
}

export class AwsS3ActiveCollectionStore implements ActiveCollectionStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly key: string,
  ) {}

  async read(environment: DevelopmentEnvironmentIdentityV1): Promise<ActiveCollectionSnapshot> {
    let output: GetObjectCommandOutput;
    try {
      output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key }));
    } catch (error) {
      if (isMissing(error)) {
        return {};
      }
      throw mapAwsError(error, "Unable to read the active collection record");
    }
    if (!output.Body || !output.ETag) {
      throw new RemoteDevelopmentError(
        "environment_drift",
        "Active collection record has no body or revision",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(await output.Body.transformToString("utf8"));
    } catch {
      throw new RemoteDevelopmentError("environment_drift", "Active collection record is corrupt");
    }
    const record = validateActiveRecord(value, environment);
    return { revision: output.ETag, record };
  }

  async compareAndSwap(
    environment: DevelopmentEnvironmentIdentityV1,
    expectedRevision: string | undefined,
    record: ActiveCollectionRecordV1,
  ): Promise<
    { readonly status: "written"; readonly revision: string } | { readonly status: "conflict" }
  > {
    validateActiveRecord(record, environment);
    try {
      const output = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key,
          Body: JSON.stringify(record),
          ContentType: "application/vnd.sweatpants.active-collection+json",
          ServerSideEncryption: "AES256",
          ...(expectedRevision === undefined
            ? { IfNoneMatch: "*" }
            : { IfMatch: expectedRevision }),
        }),
      );
      if (!output.ETag) {
        throw new RemoteDevelopmentError(
          "environment_drift",
          "Active collection write returned no revision",
        );
      }
      return { status: "written", revision: output.ETag };
    } catch (error) {
      if (isConflict(error)) {
        return { status: "conflict" };
      }
      throw mapAwsError(error, "Unable to conditionally update the active collection record");
    }
  }
}

export async function resolveAwsAccountId(region: string): Promise<string> {
  try {
    const output = await new STSClient({ region, credentials: awsCredentials() }).send(
      new GetCallerIdentityCommand({}),
    );
    if (!output.Account) {
      throw new RemoteDevelopmentError(
        "aws_authentication_failed",
        "AWS caller identity returned no account ID",
      );
    }
    return output.Account;
  } catch (error) {
    throw mapAwsError(error, "Unable to resolve AWS caller identity");
  }
}

export function createAwsS3Client(region: string): S3Client {
  return new S3Client({ region, credentials: awsCredentials() });
}

function awsCredentials(): ReturnType<typeof defaultProvider> {
  return defaultProvider(
    process.env["AWS_PROFILE"] === undefined ? {} : { profile: process.env["AWS_PROFILE"] },
  );
}

function validateActiveRecord(
  value: unknown,
  environment: DevelopmentEnvironmentIdentityV1,
): ActiveCollectionRecordV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { format?: unknown }).format !== ACTIVE_COLLECTION_FORMAT
  ) {
    throw new RemoteDevelopmentError(
      "environment_drift",
      "Active collection record does not use the closed v1 format",
    );
  }
  const record = value as ActiveCollectionRecordV1;
  if (
    !Number.isSafeInteger(record.epoch) ||
    record.epoch <= 0 ||
    !record.writerId ||
    JSON.stringify(record.environment) !== JSON.stringify(environment)
  ) {
    throw new RemoteDevelopmentError(
      "environment_drift",
      "Active collection record identity is invalid",
    );
  }
  return Object.freeze(record);
}

function mapAwsError(error: unknown, message: string): RemoteDevelopmentError {
  if (error instanceof RemoteDevelopmentError) {
    return error;
  }
  const name = awsName(error);
  const code =
    name === "CredentialsProviderError" || name === "ExpiredTokenException"
      ? "aws_authentication_failed"
      : name === "AccessDenied" || name === "AccessDeniedException"
        ? "aws_authorization_failed"
        : "placement_unavailable";
  return new RemoteDevelopmentError(code, message, { details: { awsError: bounded(name) } });
}

function isMissing(error: unknown): boolean {
  const name = awsName(error);
  return name === "NoSuchKey" || name === "NoSuchVersion" || name === "NotFound";
}

function isConflict(error: unknown): boolean {
  const status =
    error && typeof error === "object"
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
  return status === 409 || status === 412 || awsName(error) === "PreconditionFailed";
}

function awsName(error: unknown): string {
  return error && typeof error === "object" && "name" in error
    ? String((error as { name: unknown }).name)
    : "UnknownAwsError";
}

function bounded(value: unknown): string {
  return [...String(value)]
    .map((character) => (character.charCodeAt(0) < 32 ? "?" : character))
    .join("")
    .slice(0, 160);
}
