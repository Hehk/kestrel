# Pull Request Diff Fixtures

These fixtures are small GitHub-style git diffs used to validate the pull request diff parser.

| Fixture                | Coverage                                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| `multi-file.diff`      | Multiple files, multiple hunks, function context, and empty source lines |
| `added-file.diff`      | New file and `/dev/null` old path                                        |
| `deleted-file.diff`    | Deleted file and `/dev/null` new path                                    |
| `renamed-file.diff`    | Rename metadata with edited text                                         |
| `copied-file.diff`     | Copy metadata with edited text                                           |
| `hunkless-files.diff`  | Empty create/delete and pure rename/copy operations                      |
| `binary-files.diff`    | Binary marker and git binary patch forms                                 |
| `mode-only.diff`       | Executable-bit-only change with no hunks                                 |
| `quoted-paths.diff`    | Spaces and Git C-style quoted paths                                      |
| `missing-newline.diff` | Missing-final-newline markers on both sides                              |
| `long-line.diff`       | A source line long enough to exercise non-wrapping behavior              |
| `malformed.diff`       | Intentionally truncated hunk with inconsistent line counts               |

Keep these committed fixtures short and readable. Performance fixtures with 50,000 or 100,000 lines must be generated in tests or profiling scripts rather than checked into source control.

Generated performance scenarios must be deterministic and record expected file, hunk, source-line, and visual-row counts. The canonical matrix includes one large hunk, many files, many hunks, alternating line kinds, and header-heavy input. Pathological generated inputs also cover high match cardinality, 64 KiB renderer-only lines, the 512 KiB API source-line boundary, one 100,000-line copy target, and large literal and delta binary patches.
