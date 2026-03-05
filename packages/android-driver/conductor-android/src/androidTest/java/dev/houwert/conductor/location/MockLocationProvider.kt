package dev.houwert.conductor.location

import android.location.Location

interface MockLocationProvider {

    fun setLocation(location: Location)

    fun enable()

    fun disable()

    fun getProviderName(): String
}