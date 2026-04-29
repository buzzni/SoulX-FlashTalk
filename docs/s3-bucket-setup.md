# S3 Bucket Setup — SoulX-FlashTalk PoC Demo

**Audience**: AILab infra team. Frontend / backend engineers don't need
to read this — the app itself works on a fresh dev machine without any
of these settings (it falls back to local disk when S3 credentials are
absent).

**Outcome**: backend can read/write under
`s3://ailab-demo/dev/soulx-flashtalk/*` so generated host images, TTS
audio, and rendered mp4 videos move out of the GPU box's local disk
and into S3.

---

## What the backend needs

Four `.env` values:

```
S3_BUCKET=ailab-demo
S3_REGION=ap-northeast-2          # adjust to the bucket's actual region
S3_ACCESS_KEY=<paste from infra>
S3_SECRET_KEY=<paste from infra>
```

Optional defaults that are already correct for this PoC:

```
S3_ENV_PREFIX=dev
S3_PROJECT_NAME=soulx-flashtalk
```

The combined object-key shape is:

```
ailab-demo/{S3_ENV_PREFIX}/{S3_PROJECT_NAME}/{storage_key}
        = ailab-demo/dev/soulx-flashtalk/uploads/host_xxx.png
        = ailab-demo/dev/soulx-flashtalk/outputs/<task_id>.mp4
        = ailab-demo/dev/soulx-flashtalk/examples/woman.png
```

---

## 1. IAM policy (required)

Attach to the IAM user / role whose access key the backend uses. Grants
*only* the prefix needed; can't read or write anywhere else in
`ailab-demo`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ObjectIO",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::ailab-demo/dev/soulx-flashtalk/*"
    },
    {
      "Sid": "ListPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::ailab-demo",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["dev/soulx-flashtalk/*"]
        }
      }
    },
    {
      "Sid": "HeadBucketSanity",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::ailab-demo"
    }
  ]
}
```

The `HeadBucketSanity` statement is the one the backend's startup
`head_bucket()` call needs — without it the boot-time sanity check
returns 403 even when object access works.

---

## 2. Lifecycle rules (recommended, safe to skip for the demo)

Without these the bucket grows forever and partially-uploaded multipart
files cost storage indefinitely. None block app correctness — they're
cost / hygiene.

```json
{
  "Rules": [
    {
      "ID": "abort-incomplete-mpu-1d",
      "Status": "Enabled",
      "Filter": {"Prefix": "dev/soulx-flashtalk/"},
      "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}
    },
    {
      "ID": "expire-uploads-60d",
      "Status": "Enabled",
      "Filter": {"Prefix": "dev/soulx-flashtalk/uploads/"},
      "Expiration": {"Days": 60}
    },
    {
      "ID": "expire-outputs-30d",
      "Status": "Enabled",
      "Filter": {"Prefix": "dev/soulx-flashtalk/outputs/"},
      "Expiration": {"Days": 30}
    }
  ]
}
```

(Don't expire `dev/soulx-flashtalk/examples/` — those are seed assets
the wizard falls back to.)

---

## 3. CORS (only if the frontend will fetch presigned URLs cross-origin)

The PoC frontend goes through the FastAPI backend's `/api/files` and
`/api/videos` endpoints, which 302-redirect to S3. Browsers handle
those redirects directly, so the S3 response needs CORS headers — at
minimum for `Range` (mp4 byte-range seek) to work.

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:5555",
      "http://<demo-host>:5555"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "If-Range", "If-None-Match"],
    "ExposeHeaders": [
      "Content-Range",
      "Content-Length",
      "Accept-Ranges",
      "ETag"
    ],
    "MaxAgeSeconds": 3000
  }
]
```

Without CORS:
- Image / audio loads still work (no CORS preflight on basic GETs).
- mp4 byte-range seek breaks — the player can't read past the first
  chunk in some browsers (mobile Safari especially).

---

## 4. Bucket policy (recommended)

Two SIDs — block plaintext HTTP, block accidental public objects:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::ailab-demo",
        "arn:aws:s3:::ailab-demo/*"
      ],
      "Condition": {"Bool": {"aws:SecureTransport": "false"}}
    }
  ]
}
```

Plus enable "Block all public access" on the bucket — the backend
serves files via presigned URLs, never via public ACLs.

---

## What gets handed to the backend team

Just the four `.env` values from §1. Once they're in `.env` and the
backend restarts, the startup logs will confirm:

```
PR S3+ cutover: media_store swapped to S3 (bucket=ailab-demo,
prefix=dev/soulx-flashtalk)
```

If the bucket / IAM is misconfigured the backend boots with a clear
error message instead of silently writing to a half-broken bucket:

```
S3 cutover failed: An error occurred (403) when calling the HeadBucket
operation: Forbidden
```

---

## One-shot: seed the examples/ prefix

After the backend has the `.env` values but before the demo goes live,
run this from the repo root on the GPU host once:

```bash
python -m scripts.upload_examples_to_s3
```

This copies `examples/woman.png`, `examples/man.png`,
`examples/man_default.png`, `examples/cantonese_16k.wav` into
`s3://ailab-demo/dev/soulx-flashtalk/examples/`. Without this step the
wizard's "default host" / "default audio" fallback paths 404.
