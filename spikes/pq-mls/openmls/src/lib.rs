use openmls::prelude::{tls_codec::*, *};
use openmls_libcrux_crypto::Provider;
use openmls_traits::{
    crypto::OpenMlsCrypto,
    signatures::{Signer, SignerError},
    OpenMlsProvider,
};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

const SUITE: Ciphersuite = Ciphersuite::MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519;
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(message: &str);
}

struct EdSigner<'a> {
    provider: &'a Provider,
    secret: Zeroizing<Vec<u8>>,
}

impl Signer for EdSigner<'_> {
    fn sign(&self, payload: &[u8]) -> Result<Vec<u8>, SignerError> {
        self.provider.crypto().sign(self.signature_scheme(), payload, &self.secret)
            .map_err(|_| SignerError::SigningError)
    }

    fn signature_scheme(&self) -> SignatureScheme {
        SignatureScheme::ED25519
    }
}

fn credential<'a>(provider: &'a Provider, name: &[u8]) -> (CredentialWithKey, EdSigner<'a>) {
    let (secret, public) = provider.crypto().signature_key_gen(SignatureScheme::ED25519).unwrap();
    (
        CredentialWithKey {
            credential: BasicCredential::new(name.to_vec()).into(),
            signature_key: public.into(),
        },
        EdSigner { provider, secret: Zeroizing::new(secret) },
    )
}

// This is a test-only binding, not a production MLS engine or credential service.
#[wasm_bindgen]
pub fn round_trip() -> String {
    #[cfg(target_arch = "wasm32")]
    std::panic::set_hook(Box::new(|info| console_error(&info.to_string())));
    let alice_provider = Provider::new().expect("Alice entropy");
    let bob_provider = Provider::new().expect("Bob entropy");
    assert!(alice_provider.crypto().supported_ciphersuites().contains(&SUITE));
    let (alice_credential, alice_signer) = credential(&alice_provider, b"alice");
    let (bob_credential, bob_signer) = credential(&bob_provider, b"bob");
    let capabilities = Capabilities::new(None, Some(&[SUITE]), None, None, None);
    let bob_package = KeyPackage::builder().leaf_node_capabilities(capabilities.clone())
        .build(SUITE, &bob_provider, &bob_signer, bob_credential).unwrap();
    let config = MlsGroupCreateConfig::builder().ciphersuite(SUITE)
        .capabilities(capabilities).use_ratchet_tree_extension(true).build();
    let mut alice = MlsGroup::new_with_group_id(
        &alice_provider, &alice_signer, &config, GroupId::from_slice(b"pq-mls-spike"), alice_credential,
    ).unwrap();
    let (commit, welcome, _) = alice.add_members(
        &alice_provider, &alice_signer, &[bob_package.key_package().clone()],
    ).unwrap();
    let commit_bytes = commit.to_bytes().unwrap().len();
    let welcome_wire = welcome.to_bytes().unwrap();
    alice.merge_pending_commit(&alice_provider).unwrap();
    let welcome = match MlsMessageIn::tls_deserialize_exact(&welcome_wire).unwrap().extract() {
        MlsMessageBodyIn::Welcome(welcome) => welcome,
        _ => panic!("Expected Welcome"),
    };
    let join_config = MlsGroupJoinConfig::builder().use_ratchet_tree_extension(true).build();
    let mut bob = StagedWelcome::new_from_welcome(&bob_provider, &join_config, welcome, None)
        .unwrap().into_group(&bob_provider).unwrap();
    assert_eq!(alice.ciphersuite(), SUITE);
    assert_eq!(bob.ciphersuite(), SUITE);
    assert_eq!(alice.members().count(), 2);
    assert_eq!(alice.epoch_authenticator().as_slice(), bob.epoch_authenticator().as_slice());
    let update = alice.self_update(&alice_provider, &alice_signer, LeafNodeParameters::default())
        .unwrap().into_contents().0.to_bytes().unwrap();
    let protocol = MlsMessageIn::tls_deserialize_exact(&update).unwrap().try_into_protocol_message().unwrap();
    let processed = bob.process_message(&bob_provider, protocol).unwrap();
    match processed.into_content() {
        ProcessedMessageContent::StagedCommitMessage(staged) => bob.merge_staged_commit(&bob_provider, *staged).unwrap(),
        _ => panic!("Expected staged commit"),
    }
    alice.merge_pending_commit(&alice_provider).unwrap();
    assert_eq!(alice.epoch_authenticator().as_slice(), bob.epoch_authenticator().as_slice());
    let mut sizes = Vec::new();
    for length in [0, 32, 1024] {
        let plaintext = vec![42u8; length];
        let wire = alice.create_message(&alice_provider, &alice_signer, &plaintext).unwrap().to_bytes().unwrap();
        let protocol = MlsMessageIn::tls_deserialize_exact(&wire).unwrap().try_into_protocol_message().unwrap();
        let processed = bob.process_message(&bob_provider, protocol).unwrap();
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => assert_eq!(message.into_bytes(), plaintext),
            _ => panic!("Expected application message"),
        }
        let replay = MlsMessageIn::tls_deserialize_exact(&wire).unwrap().try_into_protocol_message().unwrap();
        assert!(bob.process_message(&bob_provider, replay).is_err());
        // A distinct generation tests AEAD rejection rather than replay rejection.
        let mut tampered = alice.create_message(&alice_provider, &alice_signer, &plaintext).unwrap().to_bytes().unwrap();
        *tampered.last_mut().unwrap() ^= 1;
        let protocol = MlsMessageIn::tls_deserialize_exact(&tampered).unwrap().try_into_protocol_message().unwrap();
        assert!(bob.process_message(&bob_provider, protocol).is_err());
        sizes.push(serde_json::json!({"plaintext": length, "wire": wire.len(), "overhead": wire.len() - length}));
    }
    serde_json::json!({
        "library": "openmls", "suite": u16::from(SUITE), "members": 2,
        "commitBytes": commit_bytes, "welcomeBytes": welcome_wire.len(), "messages": sizes,
    }).to_string()
}

#[test]
fn native_xwing_round_trip() {
    assert!(round_trip().contains("\"members\":2"));
}
