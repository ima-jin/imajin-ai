-- Ryan's dev + prod DIDs
UPDATE auth.identities SET upload_limit_mb = 2048 WHERE id IN (
  'did:imajin:6JSKE52ySFid2x7ejUEw6VV1NyJA1idfVKpg3We9b5Nc',
  'did:imajin:88kPYWwv5YFrQwAteEmSndbbHWvzePJ1zNSxpBCCNWXU'
);
