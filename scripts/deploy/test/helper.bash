# Loaded by every .bats file (`load helper`): the deploy libraries in the test shell.
DEPLOY_DIR=$(cd "$BATS_TEST_DIRNAME/.." && pwd)
REPO_DIR=$(cd "$DEPLOY_DIR/../.." && pwd)
for lib in common env config edge; do
  if [ -f "$DEPLOY_DIR/lib/$lib.sh" ]; then
    # shellcheck source=/dev/null
    source "$DEPLOY_DIR/lib/$lib.sh"
  fi
done
