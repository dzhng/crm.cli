/**
 * CRM FUSE3 helper binary.
 *
 * Mounts the CRM SQLite database as a virtual filesystem.
 * Compiled with: gcc -o crm-fuse src/fuse-helper.c $(pkg-config --cflags --libs fuse3) -lsqlite3
 *
 * Usage: crm-fuse -f <mountpoint> -- <db-path>
 *
 * This is a standalone C program spawned by `crm mount`. It implements the
 * FUSE3 operations to serve the CRM data as files and directories.
 */
#define FUSE_USE_VERSION 35
#include <fuse3/fuse.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <ctype.h>

static sqlite3 *g_db = NULL;

/* Slugify a name for filenames */
static void slugify(const char *input, char *output, size_t maxlen) {
    size_t j = 0;
    for (size_t i = 0; input[i] && j < maxlen - 1; i++) {
        char c = input[i];
        if (c >= 'A' && c <= 'Z') c = c - 'A' + 'a';
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
            output[j++] = c;
        } else if (j > 0 && output[j-1] != '-') {
            output[j++] = '-';
        }
    }
    while (j > 0 && output[j-1] == '-') j--;
    output[j] = '\0';
}

/* Top-level directories */
static const char *top_dirs[] = {
    "contacts", "companies", "deals", "activities",
    "reports", "search", NULL
};

/* Top-level virtual files */
static const char *top_files[] = {
    "pipeline.json", "tags.json", NULL
};

/* Check if a string is in a null-terminated array */
static int in_array(const char *needle, const char **haystack) {
    for (int i = 0; haystack[i]; i++) {
        if (strcmp(needle, haystack[i]) == 0) return 1;
    }
    return 0;
}

static int crm_getattr(const char *path, struct stat *stbuf,
                        struct fuse_file_info *fi) {
    (void)fi;
    memset(stbuf, 0, sizeof(struct stat));

    if (strcmp(path, "/") == 0) {
        stbuf->st_mode = S_IFDIR | 0755;
        stbuf->st_nlink = 2;
        return 0;
    }

    /* Strip leading / */
    const char *p = path + 1;

    /* Top-level directories */
    if (in_array(p, top_dirs)) {
        stbuf->st_mode = S_IFDIR | 0755;
        stbuf->st_nlink = 2;
        return 0;
    }

    /* Top-level virtual files */
    if (in_array(p, top_files)) {
        stbuf->st_mode = S_IFREG | 0444;
        stbuf->st_nlink = 1;
        stbuf->st_size = 4096; /* approximate */
        return 0;
    }

    /* Check for entity subdirectories and files */
    /* contacts/_by-email, contacts/_by-phone, etc. */
    if (strncmp(p, "contacts/", 9) == 0 ||
        strncmp(p, "companies/", 10) == 0 ||
        strncmp(p, "deals/", 6) == 0 ||
        strncmp(p, "activities/", 11) == 0 ||
        strncmp(p, "reports/", 8) == 0) {
        /* Subdirectories starting with _by- */
        const char *slash = strchr(p, '/');
        if (slash) {
            const char *sub = slash + 1;
            if (strncmp(sub, "_by-", 4) == 0) {
                /* Check if it's a dir or a file within it */
                const char *next = strchr(sub, '/');
                if (!next) {
                    stbuf->st_mode = S_IFDIR | 0755;
                    stbuf->st_nlink = 2;
                    return 0;
                }
                /* File or subdir within _by-* */
                const char *after = next + 1;
                if (strchr(after, '/')) {
                    /* Nested dir */
                    stbuf->st_mode = S_IFDIR | 0755;
                    stbuf->st_nlink = 2;
                } else if (strstr(after, ".json")) {
                    stbuf->st_mode = S_IFREG | 0644;
                    stbuf->st_nlink = 1;
                    stbuf->st_size = 4096;
                } else {
                    stbuf->st_mode = S_IFDIR | 0755;
                    stbuf->st_nlink = 2;
                }
                return 0;
            }
            /* Entity JSON files */
            if (strstr(sub, ".json") && !strchr(sub, '/')) {
                stbuf->st_mode = S_IFREG | 0644;
                stbuf->st_nlink = 1;
                stbuf->st_size = 4096;
                return 0;
            }
        }
    }

    return -ENOENT;
}

static int crm_readdir(const char *path, void *buf, fuse_fill_dir_t filler,
                        off_t offset, struct fuse_file_info *fi,
                        enum fuse_readdir_flags flags) {
    (void)offset; (void)fi; (void)flags;

    filler(buf, ".", NULL, 0, 0);
    filler(buf, "..", NULL, 0, 0);

    if (strcmp(path, "/") == 0) {
        for (int i = 0; top_dirs[i]; i++)
            filler(buf, top_dirs[i], NULL, 0, 0);
        for (int i = 0; top_files[i]; i++)
            filler(buf, top_files[i], NULL, 0, 0);
        return 0;
    }

    const char *p = path + 1;

    if (strcmp(p, "contacts") == 0) {
        const char *subdirs[] = {
            "_by-email", "_by-phone", "_by-linkedin", "_by-x",
            "_by-bluesky", "_by-telegram", "_by-company", "_by-tag", NULL
        };
        for (int i = 0; subdirs[i]; i++)
            filler(buf, subdirs[i], NULL, 0, 0);
        /* List contact files */
        sqlite3_stmt *stmt;
        if (sqlite3_prepare_v2(g_db,
            "SELECT id, name FROM contacts", -1, &stmt, NULL) == SQLITE_OK) {
            while (sqlite3_step(stmt) == SQLITE_ROW) {
                const char *id = (const char *)sqlite3_column_text(stmt, 0);
                const char *name = (const char *)sqlite3_column_text(stmt, 1);
                char slug[256], fname[512];
                slugify(name ? name : "unknown", slug, sizeof(slug));
                snprintf(fname, sizeof(fname), "%s...%s.json", id, slug);
                filler(buf, fname, NULL, 0, 0);
            }
            sqlite3_finalize(stmt);
        }
        return 0;
    }

    if (strcmp(p, "companies") == 0) {
        const char *subdirs[] = {"_by-website", "_by-phone", "_by-tag", NULL};
        for (int i = 0; subdirs[i]; i++)
            filler(buf, subdirs[i], NULL, 0, 0);
        sqlite3_stmt *stmt;
        if (sqlite3_prepare_v2(g_db,
            "SELECT id, name FROM companies", -1, &stmt, NULL) == SQLITE_OK) {
            while (sqlite3_step(stmt) == SQLITE_ROW) {
                const char *id = (const char *)sqlite3_column_text(stmt, 0);
                const char *name = (const char *)sqlite3_column_text(stmt, 1);
                char slug[256], fname[512];
                slugify(name ? name : "unknown", slug, sizeof(slug));
                snprintf(fname, sizeof(fname), "%s...%s.json", id, slug);
                filler(buf, fname, NULL, 0, 0);
            }
            sqlite3_finalize(stmt);
        }
        return 0;
    }

    if (strcmp(p, "deals") == 0) {
        const char *subdirs[] = {"_by-stage", "_by-company", "_by-tag", NULL};
        for (int i = 0; subdirs[i]; i++)
            filler(buf, subdirs[i], NULL, 0, 0);
        sqlite3_stmt *stmt;
        if (sqlite3_prepare_v2(g_db,
            "SELECT id, title FROM deals", -1, &stmt, NULL) == SQLITE_OK) {
            while (sqlite3_step(stmt) == SQLITE_ROW) {
                const char *id = (const char *)sqlite3_column_text(stmt, 0);
                const char *title = (const char *)sqlite3_column_text(stmt, 1);
                char slug[256], fname[512];
                slugify(title ? title : "unknown", slug, sizeof(slug));
                snprintf(fname, sizeof(fname), "%s...%s.json", id, slug);
                filler(buf, fname, NULL, 0, 0);
            }
            sqlite3_finalize(stmt);
        }
        return 0;
    }

    if (strcmp(p, "activities") == 0) {
        const char *subdirs[] = {
            "_by-contact", "_by-company", "_by-deal", "_by-type", NULL
        };
        for (int i = 0; subdirs[i]; i++)
            filler(buf, subdirs[i], NULL, 0, 0);
        return 0;
    }

    if (strcmp(p, "reports") == 0) {
        const char *files[] = {
            "pipeline.json", "stale.json", "forecast.json",
            "conversion.json", "velocity.json", "won.json", "lost.json", NULL
        };
        for (int i = 0; files[i]; i++)
            filler(buf, files[i], NULL, 0, 0);
        return 0;
    }

    if (strcmp(p, "search") == 0) {
        return 0;
    }

    /* deals/_by-stage */
    if (strcmp(p, "deals/_by-stage") == 0) {
        const char *stages[] = {
            "lead", "qualified", "proposal",
            "negotiation", "closed-won", "closed-lost", NULL
        };
        for (int i = 0; stages[i]; i++)
            filler(buf, stages[i], NULL, 0, 0);
        return 0;
    }

    return -ENOENT;
}

static int crm_open(const char *path, struct fuse_file_info *fi) {
    (void)path; (void)fi;
    return 0;
}

static int crm_read(const char *path, char *buf, size_t size, off_t offset,
                     struct fuse_file_info *fi) {
    (void)fi;

    /* Generate JSON content for the requested path */
    char content[65536] = "{}";
    size_t content_len = 2;

    const char *p = path + 1;

    if (strcmp(p, "pipeline.json") == 0 ||
        strcmp(p, "reports/pipeline.json") == 0) {
        /* Pipeline report */
        int pos = 0;
        pos += snprintf(content + pos, sizeof(content) - pos, "[");
        const char *stages[] = {
            "lead", "qualified", "proposal",
            "negotiation", "closed-won", "closed-lost", NULL
        };
        for (int i = 0; stages[i]; i++) {
            sqlite3_stmt *stmt;
            char sql[256];
            snprintf(sql, sizeof(sql),
                "SELECT COUNT(*), COALESCE(SUM(value),0) FROM deals WHERE stage='%s'",
                stages[i]);
            int count = 0;
            double value = 0;
            if (sqlite3_prepare_v2(g_db, sql, -1, &stmt, NULL) == SQLITE_OK) {
                if (sqlite3_step(stmt) == SQLITE_ROW) {
                    count = sqlite3_column_int(stmt, 0);
                    value = sqlite3_column_double(stmt, 1);
                }
                sqlite3_finalize(stmt);
            }
            if (i > 0) pos += snprintf(content + pos, sizeof(content) - pos, ",");
            pos += snprintf(content + pos, sizeof(content) - pos,
                "{\"stage\":\"%s\",\"count\":%d,\"value\":%.0f}",
                stages[i], count, value);
        }
        pos += snprintf(content + pos, sizeof(content) - pos, "]");
        content_len = pos;
    } else if (strcmp(p, "tags.json") == 0) {
        snprintf(content, sizeof(content), "[]");
        content_len = 2;
    }

    if ((size_t)offset >= content_len) return 0;
    if (offset + size > content_len) size = content_len - offset;
    memcpy(buf, content + offset, size);
    return size;
}

static const struct fuse_operations crm_ops = {
    .getattr  = crm_getattr,
    .readdir  = crm_readdir,
    .open     = crm_open,
    .read     = crm_read,
};

int main(int argc, char *argv[]) {
    /* Find the DB path after "--" separator */
    const char *db_path = NULL;
    int fuse_argc = argc;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--") == 0 && i + 1 < argc) {
            db_path = argv[i + 1];
            fuse_argc = i;
            break;
        }
    }

    if (!db_path) {
        fprintf(stderr, "Usage: crm-fuse -f <mountpoint> -- <db-path>\n");
        return 1;
    }

    /* Open SQLite database */
    if (sqlite3_open(db_path, &g_db) != SQLITE_OK) {
        fprintf(stderr, "Failed to open database: %s\n", sqlite3_errmsg(g_db));
        return 1;
    }

    int ret = fuse_main(fuse_argc, argv, &crm_ops, NULL);

    sqlite3_close(g_db);
    return ret;
}
