# Broker Consent Vocabulary (#1444)

This is the pinned purpose, field-name, release-mode, predicate, and term registry artifact for broker consent config. Both Imajin broker code and counterparties should adopt these strings directly instead of inventing local synonyms.

## Why this exists

The broker supports the release-mode set `raw | attestation | none`, but those modes are only safe when both sides use the same purpose and field names. Set predicates make this a safety requirement: `peanuts`, `peanut`, and `arachis` must resolve to one canonical term before a restaurant/allergy gate can return a trustworthy boolean.

The source of truth is `packages/auth/src/broker-consent-vocabulary.ts`, exported as `@imajin/auth/broker-consent-vocabulary`.

## Release modes

- `raw` discloses the field value.
- `attestation` withholds the raw value and returns a signed predicate claim or an explicit attested sentinel.
- `none` is an explicit deny in remote config. It should not be stored as a consent grant that releases data.

## Canonical purposes for remote config

- `restaurant_reservation` covers restaurant and travel-dining flows. Initial allowed fields are `name`, `email`, `phone`, `dietary`, `allergies`, `accessibility_needs`, `budget`, `party_size`, and `reservation_time`.
- `hotel_checkin` covers hospitality check-in flows. Initial allowed fields are `name`, `legal_name`, `email`, `phone`, `arrival_time`, `accessibility_needs`, `dietary`, and `allergies`.
- `platform_services` covers core platform service delivery, profile display, notifications, and account support. Initial allowed fields are `name`, `displayName`, `avatar`, `bio`, `email`, `phone`, `locale`, and `timezone`.

The module also includes compatibility purposes already used by the current broker defaults and kernel routes: `profile.field`, `contact.disclosure`, `marketing`, `profile`, `analytics`, and `event-registration`.

## Field and predicate rules

- Scalar fields use `eq`, `gte`, `lte`, and/or `is_empty` depending on field type.
- Set fields use `contains(term)`, `overlaps(declaredSet, sovereignSet)`, and/or `is_empty`.
- `count` and `overlaps_count` are intentionally absent from v1 because they disclose a number.
- Set fields must name a term vocabulary before they can participate in `contains` or `overlaps`.

Initial set vocabularies:

- `allergen`: canonical terms such as `peanut`, `tree_nut`, `shellfish`, `egg`, `wheat`, `milk`, `soy`, `fish`, and `sesame`.
- `dietary_preference`: canonical terms such as `vegan`, `vegetarian`, `pescatarian`, `gluten_free`, `dairy_free`, `kosher`, and `halal`.
- `accessibility_need`: canonical terms such as `wheelchair_access`, `step_free_access`, `service_animal`, `hearing_access`, and `vision_access`.

Aliases are accepted only as normalization inputs. Persist and compare the canonical term string.

## Remote config guidance

Remote config should name:

- `purpose`, using a purpose from `BROKER_PURPOSE_VOCABULARY`.
- `field`, using a field from `BROKER_FIELD_VOCABULARY` that is allowed for that purpose.
- `mode`, using one of `BROKER_RELEASE_MODES`.
- `predicate`, when mode is `attestation` and a value claim is needed.
- `arg` or declared set terms, normalized through the relevant term vocabulary for set predicates.

For the restaurant/allergy gate, the requester declares dish terms using the `allergen` vocabulary, the broker evaluates overlap against the subject's canonical `allergies` set, and only the boolean crosses the boundary.
