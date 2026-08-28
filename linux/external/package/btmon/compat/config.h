/* What bluez's configure would have generated, reduced to what the btmon
 * sources actually reference. No HAVE_UDEV: monitor/hwdb.c then falls back
 * to its no-lookup stub, which is right for a machine with no hwdb. */
#define VERSION "5.79"
#define PACKAGE_VERSION VERSION
