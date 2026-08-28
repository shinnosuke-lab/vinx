/* btmon seeds GATT handle names from bluetoothd's on-disk cache under
 * /var/lib/bluetooth; this machine never runs bluetoothd and has no such
 * cache, so loading is a no-op. The forward declaration must precede the
 * header: settings.h names the struct only inside its prototypes. */
struct gatt_db;

#include "src/settings.h"

int btd_settings_gatt_db_load(struct gatt_db *db, const char *filename) {
	(void)db;
	(void)filename;
	return -1;
}

void btd_settings_gatt_db_store(struct gatt_db *db, const char *filename) {
	(void)db;
	(void)filename;
}
