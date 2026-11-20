/* Test-owned native target: no Paseo/esbuild code. Standard descriptor continuity. */
#include <unistd.h>
#include <string.h>
#include <fcntl.h>
#include <errno.h>
int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "--service=0.25.12") || strcmp(argv[2], "--ping")) return 64;
  if (fcntl(3, F_GETFD) != -1 || errno != EBADF) return 65;
  if (write(2, "native-stderr\n", 14) != 14) return 74;
  char buffer[256];
  ssize_t count;
  while ((count = read(0, buffer, sizeof buffer)) > 0) {
    if (write(1, buffer, count) != count) return 74;
  }
  return 0;
}
