package im.plum.plumbox.client

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * A [TokenStore] that keeps the connection (the whole token set, `iss` and
 * `clientId`) encrypted with AES-256-GCM under a key in the Android
 * Keystore, in this app's private SharedPreferences.
 *
 * - The key never leaves the Keystore (hardware-backed where the device has
 *   it); the preferences file holds only ciphertext, bound to [name].
 * - A copy of the file on another device (a backup restored elsewhere) cannot
 *   be decrypted there — the key does not travel — so it reads as "no
 *   connection" instead of two devices sharing one rotating refresh token.
 *   Still exclude the file from backup (see the README).
 * - Writes are synchronous (`commit`): a rotated refresh token is on disk
 *   before the request that needed it is retried.
 * - Anything unreadable (a lost key, a damaged file) is dropped and [load]
 *   returns `null`: the user connects again.
 *
 * Plain Keystore + SharedPreferences rather than
 * `androidx.security:security-crypto` (EncryptedSharedPreferences), which is
 * deprecated.
 *
 * @param name keeps several connections apart (one store per name); it names
 *   the preferences file `im.plum.plumbox.client.<name>` and the Keystore key.
 */
// commit(), not apply(): the rotated refresh token must be on disk before the
// retried request goes out (a lost write would bring back a dead token).
@SuppressLint("ApplySharedPref")
public class KeystoreTokenStore @JvmOverloads constructor(
    context: Context,
    private val name: String = "default",
) : TokenStore {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("$PREFIX.$name", Context.MODE_PRIVATE)
    private val alias = "$PREFIX.$name"
    private val aad = "plumbox-client:$name".toByteArray(Charsets.UTF_8)

    override suspend fun load(): PlumConnection? = withContext(Dispatchers.IO) {
        val blob = prefs.getString(KEY, null) ?: return@withContext null
        val connection = try {
            val key = key(create = false)
            key?.let { ConnectionCodec.decode(SealedBox.open(it, blob, aad)) }
        } catch (_: Exception) {
            null
        }
        if (connection == null) prefs.edit().remove(KEY).commit()
        connection
    }

    override suspend fun save(connection: PlumConnection) {
        withContext(Dispatchers.IO) {
            val blob = SealedBox.seal(checkNotNull(key(create = true)), ConnectionCodec.encode(connection), aad)
            check(prefs.edit().putString(KEY, blob).commit()) { "KeystoreTokenStore: could not write $PREFIX.$name" }
        }
    }

    override suspend fun clear() {
        withContext(Dispatchers.IO) {
            prefs.edit().remove(KEY).commit()
            synchronized(keyLock) {
                runCatching { keyStore().deleteEntry(alias) }
            }
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun key(create: Boolean): SecretKey? = synchronized(keyLock) {
        (keyStore().getKey(alias, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // The Keystore picks every IV: no nonce is ever reused.
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        generator.generateKey()
    }

    private companion object {
        const val PREFIX = "im.plum.plumbox.client"
        const val KEY = "connection"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"

        /** One lock for every instance: two stores of the same name must not each make a key. */
        val keyLock = Any()
    }
}
